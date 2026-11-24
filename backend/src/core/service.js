import crypto from "node:crypto";
import { ApiError, ensure, requiredText, optionalText } from "./errors.js";
import { emptyState } from "./defaults.js";
import { resetSettledHistory } from "./settledReset.js";
import { measure } from "./performance.js";
import {
  amount,
  cents,
  realId,
  alias,
  pairId,
  expenseShares,
  debtFlows,
  applyPairFlow,
  reversePairFlow,
  applySettlementFlow,
  settlementVector,
} from "./money.js";

const profileKey = (uid) => ({ userId: `USER#${uid}`, recordId: "PROFILE" });
const ledgerKey = (id, recordId = "STATE") => ({ ledgerId: id, recordId });
const normalize = (value) =>
  String(value || "")
    .trim()
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "");
const username = (value) => normalize(value).replace(/^@+/, "");
const reserved = new Set([
  "admin",
  "support",
  "official",
  "splittrack",
  "splitrack",
  "help",
  "api",
  "system",
]);
const jsonHash = (value) =>
  crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
const keyOf = (table, item) =>
  JSON.stringify(
    table === "data"
      ? { userId: item.userId, recordId: item.recordId }
      : table === "transactions"
        ? { ledgerId: item.ledgerId, transactionId: item.transactionId }
        : table === "recurring"
          ? { ledgerId: item.ledgerId, recurringId: item.recurringId }
          : table === "templates"
            ? { ledgerId: item.ledgerId, templateId: item.templateId }
            : { ledgerId: item.ledgerId, recordId: item.recordId },
  );
const mutateNumber = (object, key, delta) => {
  object[key] = (object[key] || 0) + delta;
  ensure(
    Number.isSafeInteger(object[key]),
    "Financial total exceeds the supported range.",
  );
};
const usableAccounts = (state) =>
  state.accounts.filter((account) => !account.archived);
const activeAccount = (state, id) =>
  state.accounts.find((account) => account.id === id && !account.archived);
const receivingProfileFields = (profile) => ({
  upiId: profile?.upiId || undefined,
  paymentName: profile?.upiId ? profile.paymentName || profile.name || undefined : undefined,
  receivingProvider: profile?.upiId ? profile.receivingProvider || undefined : undefined,
  receivingBankBrand: profile?.upiId ? profile.receivingBankBrand || undefined : undefined,
});
const searchKeys = (profile) =>
  [
    ...new Set(
      [
        normalize(profile.name),
        ...normalize(profile.name).split(/\s+/),
        profile.username,
      ].filter(Boolean),
    ),
  ].map((value) => ({
    userId: `SEARCH#${value[0]}`,
    recordId: `${value}#${profile.uid}`,
  }));
const imageRef = (value, uid) => {
  const ref = optionalText(value, 1500);
  ensure(
    !ref ||
      /^cartoon:[a-z0-9_-]+$/.test(ref) ||
      /^https:\/\//.test(ref) ||
      ref.startsWith(`media:app-media/${uid}/`),
    "Upload the image before saving it.",
  );
  return ref;
};

class Work {
  constructor(repo, allowReset = false) {
    this.repo = repo;
    this.allowReset = allowReset;
    this.cache = new Map();
    this.states = new Map();
    this.changedStates = new Set();
    this.changedRows = new Map();
    this.actions = new Map();
  }
  async get(table, key) {
    const cacheKey = `${table}:${JSON.stringify(key)}`;
    if (!this.cache.has(cacheKey))
      this.cache.set(cacheKey, this.repo.get(table, key));
    return this.cache.get(cacheKey);
  }
  async state(uid) {
    if (!this.states.has(uid))
      this.states.set(
        uid,
        structuredClone(
          (await this.get("ledger", ledgerKey(uid))) || emptyState(uid),
        ),
      );
    return this.states.get(uid);
  }
  async profile(uid) {
    return this.get("data", profileKey(uid));
  }
  async pair(a, b) {
    const id = pairId(a, b);
    let row = await this.get("ledger", ledgerKey(id));
    if (!row) {
      row = { ...ledgerKey(id), revision: 0, claims: [] };
      this.cache.set(`ledger:${JSON.stringify(ledgerKey(id))}`, row);
    }
    return row;
  }
  async trip(id) {
    const row = await this.get("ledger", ledgerKey(`TRIP#${id}`));
    ensure(row, "Trip not found.", 404);
    return row;
  }
  stateChanged(uid) {
    this.changedStates.add(uid);
  }
  rowChanged(row) {
    this.changedRows.set(keyOf("ledger", row), row);
  }
  put(table, item, options = {}) {
    this.actions.set(`${table}:${keyOf(table, item)}`, {
      type: "put",
      table,
      item,
      ...options,
    });
  }
  delete(table, key, options = {}) {
    this.actions.set(`${table}:${keyOf(table, key)}`, {
      type: "delete",
      table,
      key,
      ...options,
    });
  }
  async commit() {
    for (const uid of this.changedStates) {
      const state = this.states.get(uid),
        revision = state.revision;
      ensure(this.allowReset || !state.resetting, "A fresh ledger is being prepared. Please try again shortly.", 409, "LEDGER_RESETTING");
      state.revision++;
      state.updatedAt = new Date().toISOString();
      ensure(
        Buffer.byteLength(JSON.stringify(state)) < 300_000,
        "Your account has too much active metadata for this operation.",
        409,
      );
      this.put("ledger", state, { revision });
    }
    for (const row of this.changedRows.values()) {
      const revision = row.revision;
      row.revision++;
      row.updatedAt = new Date().toISOString();
      this.put("ledger", row, { revision });
    }
    ensure(
      this.actions.size <= 100,
      "This operation is too large. Please use a smaller group or batch.",
    );
    if (this.actions.size) await this.repo.transact([...this.actions.values()]);
  }
}

export class SplitTrackService {
  constructor(
    repo,
    media = {
      resolve: async (ref) => ref,
      upload: async () => {
        throw new ApiError(503, "Image uploads are not configured.");
      },
    },
  ) {
    this.repo = repo;
    this.media = media;
  }
  async bootstrap(auth) {
    for (let attempt = 0; attempt < 5; attempt++) {
      const existing = await this.repo.get("data", profileKey(auth.uid));
      if (existing) return existing;
      const work = new Work(this.repo);
      await work.state(auth.uid);
      const profile = {
        ...profileKey(auth.uid),
        uid: auth.uid,
        name:
          optionalText(auth.name, 70) ||
          optionalText(auth.email?.split("@")[0], 70) ||
          "Member",
        email: auth.email || "",
        username: "",
        avatarRef: imageRef(auth.picture, auth.uid),
        createdAt: new Date().toISOString(),
      };
      work.put("data", profile, { unique: true });
      work.stateChanged(auth.uid);
      try {
        await work.commit();
        return profile;
      } catch (error) {
        if (!this.isConflict(error) || attempt === 4) throw error;
      }
    }
  }
  isConflict(error) {
    return [
      "TransactionCanceledException",
      "ConditionalCheckFailedException",
      "TransactionConflictException",
    ].includes(error.name);
  }
  async mutation(auth, requestId, input, callback, { durable = false, includeSnapshot = true } = {}) {
    ensure(
      typeof requestId === "string" &&
        /^[A-Za-z0-9_-]{12,100}$/.test(requestId),
      "A valid idempotency-key is required.",
    );
    const profile = await this.bootstrap(auth);
    // A profile change also advances STATE. Do not reuse a profile read that
    // preceded the revision we will conditionally commit against.
    this.repo.forget?.("data", profileKey(auth.uid));
    const markerKey = ledgerKey(auth.uid, `REQUEST#${requestId}`),
      hash = jsonHash(input);
    for (let attempt = 0; attempt < 5; attempt++) {
      const work = new Work(this.repo);
      const [marker] = await Promise.all([
        work.get("ledger", markerKey),
        work.state(auth.uid),
      ]);
      if (marker) {
        ensure(
          marker.hash === hash,
          "This request ID was already used for another operation.",
          409,
          "IDEMPOTENCY_CONFLICT",
        );
        if (!includeSnapshot) return { result: marker.result };
        // The parallel state read can precede another device's commit. Read
        // again after observing its marker so a retry returns committed state.
        this.repo.invalidate?.();
        return { result: marker.result, state: await this.snapshot(auth.uid) };
      }
      try {
        const result = await callback(work);
        work.put(
          "ledger",
          {
            ...markerKey,
            revision: 1,
            hash,
            result,
            ...(durable ? {} : { expiresAt: Math.floor(Date.now() / 1000) + 7 * 86400 }),
          },
          { revision: 0 },
        );
        await work.commit();
        if (!includeSnapshot) return { result };
        const updatedProfile =
          work.actions.get(`data:${keyOf("data", profile)}`)?.item ??
          await work.profile(auth.uid);
        return {
          result,
          state: await this.snapshot(auth.uid, work.states.get(auth.uid), updatedProfile),
        };
      } catch (error) {
        if (!this.isConflict(error)) throw error;
        if (attempt === 4)
          throw new ApiError(
            409,
            "Another device updated this account. Please retry.",
            "WRITE_CONFLICT",
          );
        await new Promise((resolve) => setTimeout(resolve, 20 * 2 ** attempt));
      }
    }
  }
  async publicProfile(profile) {
    return {
      id: profile.uid,
      name: profile.name,
      handle: profile.username ? `@${profile.username}` : "",
      avatar: await this.media.resolve(profile.avatarRef || ""),
      avatarRef: profile.avatarRef || "",
    };
  }
  async profile(auth) {
    const [profile, state] = await Promise.all([
      this.bootstrap(auth),
      this.repo.get("ledger", ledgerKey(auth.uid)),
    ]);
    return {
      ...(await this.publicProfile(profile)),
      ...receivingProfileFields(profile),
      email: profile.email,
      username: profile.username,
      displayName: profile.name,
      settings: (state || emptyState(auth.uid)).settings,
    };
  }
  async usernameAvailable(value, uid) {
    const normalized = username(value);
    if (!/^[a-z0-9_.]{3,24}$/.test(normalized) || reserved.has(normalized))
      return { available: false };
    const claim = await this.repo.get("data", {
      userId: `USERNAME#${normalized}`,
      recordId: "CLAIM",
    });
    return { available: !claim || claim.uid === uid };
  }
  async search(value, uid) {
    const query = normalize(value).replace(/^@+/, "").slice(0, 70);
    if (!query) return [];
    const exact = await this.repo.get("data", {
      userId: `USERNAME#${query}`,
      recordId: "CLAIM",
    });
    if (
      String(value || "")
        .trim()
        .startsWith("@") &&
      exact &&
      exact.uid !== uid
    ) {
      const profile = await this.repo.get("data", profileKey(exact.uid));
      return profile ? [await this.publicProfile(profile)] : [];
    }
    const rows = await this.repo.query("data", "userId", `SEARCH#${query[0]}`, {
      prefix: query,
      limit: 60,
    });
    const ids = [
      ...new Set(rows.items.map((row) => row.uid).filter((id) => id !== uid)),
    ].slice(0, 25);
    const profiles = await this.repo.many("data", ids.map(profileKey));
    return Promise.all(
      profiles
        .filter(
          (profile) =>
            profile.username &&
            (!String(value || "")
              .trim()
              .startsWith("@") ||
              profile.username.startsWith(query)),
        )
        .map((profile) => this.publicProfile(profile)),
    );
  }
  async updateProfile(auth, requestId, body) {
    return this.mutation(
      auth,
      requestId,
      { operation: "profile", body },
      async (work) => {
        const previous = await work.profile(auth.uid),
          next = { ...previous };
        next.name = requiredText(
          body.displayName || body.name || previous.name,
          "Display name",
          70,
        );
        next.username = username(body.username ?? previous.username);
        ensure(
          /^[a-z0-9_.]{3,24}$/.test(next.username) &&
            !reserved.has(next.username),
          "Use 3–24 letters, numbers, dots or underscores for the username.",
        );
        const claimKey = {
          userId: `USERNAME#${next.username}`,
          recordId: "CLAIM",
        };
        const claim = await work.get("data", claimKey);
        ensure(
          !claim || claim.uid === auth.uid,
          "That username is already taken.",
          409,
          "USERNAME_TAKEN",
        );
        if (body.avatar !== undefined || body.avatarRef !== undefined)
          next.avatarRef = imageRef(body.avatarRef ?? body.avatar, auth.uid);
        for (const key of searchKeys(previous)) work.delete("data", key);
        if (previous.username && previous.username !== next.username)
          work.delete("data", {
            userId: `USERNAME#${previous.username}`,
            recordId: "CLAIM",
          });
        work.put("data", { ...claimKey, uid: auth.uid }, { unique: true });
        for (const key of searchKeys(next))
          work.put("data", { ...key, uid: auth.uid });
        next.updatedAt = new Date().toISOString();
        work.put("data", next);
        work.stateChanged(auth.uid);
        return { id: auth.uid };
      },
    );
  }
  async link(work, owner, other) {
    ensure(other !== owner, "You are already included.");
    const profile = await work.profile(other);
    ensure(
      profile?.username,
      "That member has not finished setting up their profile.",
      404,
    );
    const state = await work.state(owner);
    if (!state.friends.some((friend) => friend.id === other)) {
      state.friends.push({ id: other, netCents: 0 });
      work.stateChanged(owner);
    }
    return state.friends.find((friend) => friend.id === other);
  }
  async resolveMember(work, body, viewer, pathId) {
    let uid = body.userId || body.friendId || pathId;
    if (body.handle) {
      const claim = await work.get("data", {
        userId: `USERNAME#${username(body.handle)}`,
        recordId: "CLAIM",
      });
      ensure(claim, "No registered member has that username.", 404);
      uid = claim.uid;
    }
    ensure(
      typeof uid === "string" && uid.length > 0,
      "Select a registered member.",
    );
    return realId(uid, viewer);
  }
  async publishReceiving(work, uid) {
    const state = await work.state(uid),
      profile = await work.profile(uid);
    const selected = activeAccount(state, state.settings.selectedAccountId);
    const previousReceiver = activeAccount(state, state.settings.receivingAccountId);
    const account =
      selected?.kind === "upi"
        ? selected
        : (previousReceiver?.kind === "upi" ? previousReceiver : undefined) ||
          usableAccounts(state).find((account) => account.kind === "upi");
    state.settings.receivingAccountId = account?.id || "";
    if (profile) {
      const receiving = {
        upiId: account?.upiId || "",
        paymentName: account?.title || "",
        receivingProvider: account ? account.provider || "bank" : "",
        receivingBankBrand: account?.bankBrand || "",
      };
      if (Object.entries(receiving).some(([key, value]) => (profile[key] || "") !== value))
        work.put("data", { ...profile, ...receiving });
    }
  }
  async saveEntity(auth, requestId, type, id, body) {
    return this.mutation(
      auth,
      requestId,
      { operation: "save", type, id, body },
      async (work) => {
        const state = await work.state(auth.uid);
        if (type === "accounts") {
          const previous = state.accounts.find((account) => account.id === id),
            account = {
              ...(previous || { id, balanceCents: 0, spentCents: 0 }),
            };
          account.title = requiredText(
            body.title || previous?.title,
            "Profile name",
            70,
          );
          for (const key of [
            "kind",
            "bankName",
            "bankBrand",
            "provider",
            "cardHolder",
            "cardNumber",
            "expiry",
            "cardType",
            "accentColor",
            "secondaryColor",
          ])
            if (body[key] !== undefined)
              account[key] = optionalText(
                body[key],
                key === "cardNumber" ? 30 : 100,
              );
          account.kind = account.kind || "upi";
          ensure(
            [
              "upi",
              "debit",
              "credit",
              "wallet",
              "forex",
              "netbanking",
            ].includes(account.kind),
            "Invalid payment profile type.",
          );
          account.upiId = optionalText(
            body.upiId ?? account.upiId,
            120,
          ).toLowerCase();
          ensure(
            account.kind !== "upi" ||
              /^[a-z0-9._-]+@[a-z0-9._-]+$/i.test(account.upiId),
            "Enter a valid UPI ID.",
          );
          ensure(
            !account.cardNumber || /^\D*\d{4}$/.test(account.cardNumber),
            "Store only the last four card digits.",
          );
          if (previous)
            state.accounts[state.accounts.indexOf(previous)] = account;
          else state.accounts.push(account);
          if (body.isDefault || !state.settings.selectedAccountId)
            state.settings.selectedAccountId = id;
          work.stateChanged(auth.uid);
          await this.publishReceiving(work, auth.uid);
          return { id };
        }
        if (type === "friends") {
          const member = await this.resolveMember(work, body, auth.uid, id);
          const friend = await this.link(work, auth.uid, member);
          await this.link(work, member, auth.uid);
          if (body.nickname !== undefined)
            friend.nickname = optionalText(body.nickname, 70);
          if (body.phone !== undefined)
            friend.phone = optionalText(body.phone, 35);
          if (body.avatarRef !== undefined)
            friend.avatarRef = imageRef(body.avatarRef, auth.uid);
          work.stateChanged(auth.uid);
          return { id: member };
        }
        if (type === "categories") {
          const category = {
            id,
            name: requiredText(body.name, "Category name", 50),
            iconKey: requiredText(body.iconKey || "tag", "Category icon", 80),
            color: body.color || "#71717A",
          };
          ensure(
            /^#[a-f0-9]{6}$/i.test(category.color),
            "Choose a valid category color.",
          );
          ensure(
            !state.categories.some(
              (item) =>
                item.id !== id &&
                normalize(item.name) === normalize(category.name),
            ),
            "That category already exists.",
            409,
          );
          const index = state.categories.findIndex((item) => item.id === id);
          if (index < 0) state.categories.push(category);
          else state.categories[index] = category;
          work.stateChanged(auth.uid);
          return { id };
        }
        if (type === "trips") {
          const key = ledgerKey(`TRIP#${id}`),
            previous = await work.get("ledger", key);
          ensure(
            !previous || previous.ownerId === auth.uid,
            "Only the trip creator can edit this trip.",
            403,
          );
          const trip = previous || {
            ...key,
            id,
            ownerId: auth.uid,
            revision: 0,
            totalSpendCents: 0,
            members: [
              ...new Set(
                (body.members || ["user"])
                  .map((member) => realId(member, auth.uid))
                  .concat(auth.uid),
              ),
            ],
          };
          ensure(!trip.deleted, "This trip was archived.", 410);
          ensure(
            trip.members.length <= 12,
            "A trip supports up to 12 members.",
          );
          trip.name = requiredText(body.name || trip.name, "Trip name", 70);
          for (const field of ["category", "icon", "startDate", "endDate"])
            if (body[field] !== undefined)
              trip[field] = optionalText(body[field], 80);
          trip.currency = "INR";
          if (body.coverImage !== undefined || body.coverImageRef !== undefined)
            trip.coverImageRef = imageRef(
              body.coverImageRef ?? body.coverImage,
              auth.uid,
            );
          if (body.coverGradient) {
            ensure(
              Array.isArray(body.coverGradient) &&
                body.coverGradient.length === 2 &&
                body.coverGradient.every((color) =>
                  /^#[a-f0-9]{6}$/i.test(color),
                ),
              "Choose a valid trip gradient.",
            );
            trip.coverGradient = body.coverGradient;
          }
          trip.coverGradient = trip.coverGradient || ["#1A3E7D", "#4D88FF"];
          for (const member of trip.members) {
            ensure(
              (await work.profile(member))?.username,
              "All trip members must have a registered profile.",
            );
            const memberState = await work.state(member);
            for (const other of trip.members)
              if (other !== member) await this.link(work, member, other);
            memberState.trips = memberState.trips
              .filter((item) => item.id !== id)
              .concat(structuredClone(trip));
            work.stateChanged(member);
          }
          work.rowChanged(trip);
          return { id };
        }
        if (type === "recurring" || type === "templates") {
          const sort = type === "recurring" ? "recurringId" : "templateId",
            key = { ledgerId: auth.uid, [sort]: id },
            previous = await work.get(type, key);
          const row = {
            ...key,
            generation: state.generation || 0,
            revision: (previous?.revision || 0) + 1,
            name: requiredText(body.name, "Name", 80),
            amount: amount(Math.abs(cents(body.amount))),
            category: optionalText(body.category, 50) || "Other",
            transactionType:
              body.transactionType === "income" ? "income" : "expense",
            upiAccountId: body.upiAccountId || state.settings.selectedAccountId,
          };
          ensure(row.amount > 0, "Amount must be positive.");
          if (row.upiAccountId)
            ensure(
              activeAccount(state, row.upiAccountId),
              "Payment profile not found.",
              404,
            );
          if (type === "recurring") {
            const due = new Date(body.nextDueDate || previous?.nextDueDate);
            ensure(
              Number.isFinite(due.getTime()),
              "Choose a valid next due date.",
            );
            row.nextDueDate = due.toISOString();
            row.frequency = body.frequency || "monthly";
            ensure(
              ["daily", "weekly", "monthly", "yearly"].includes(row.frequency),
              "Choose daily, weekly, monthly, or yearly.",
            );
            row.isActive = body.isActive !== false;
          }
          work.put(type, row, { revision: previous?.revision || 0 });
          work.stateChanged(auth.uid);
          return { id };
        }
        throw new ApiError(400, "Unsupported entity type.");
      },
    );
  }
  async settings(auth, requestId, body) {
    return this.mutation(
      auth,
      requestId,
      { operation: "settings", body },
      async (work) => {
        const state = await work.state(auth.uid);
        if (body.selectedAccountId !== undefined) {
          ensure(
            activeAccount(state, body.selectedAccountId),
            "Payment profile not found.",
            404,
          );
          state.settings.selectedAccountId = body.selectedAccountId;
        }
        if (body.themeMode !== undefined) {
          ensure(["dark", "light"].includes(body.themeMode), "Invalid theme.");
          state.settings.themeMode = body.themeMode;
        }
        if (body.selectionStyle !== undefined) {
          ensure(["chips", "dropdown"].includes(body.selectionStyle), "Invalid selection style.");
          state.settings.selectionStyle = body.selectionStyle;
        }
        if (body.notificationDirection !== undefined) {
          ensure(["top", "bottom"].includes(body.notificationDirection), "Invalid notification direction.");
          state.settings.notificationDirection = body.notificationDirection;
        }
        for (const field of ["hideAmounts", "isLiquidGlassEnabled"])
          if (body[field] !== undefined) {
            ensure(typeof body[field] === "boolean", "Invalid preference.");
            state.settings[field] = body[field];
          }
        // UPI and all stored amounts use INR. No fabricated exchange rates are applied.
        if (body.currency !== undefined) {
          ensure(
            body.currency === "INR",
            "The connected ledger currently uses INR.",
          );
          state.settings.currency = "INR";
        }
        work.stateChanged(auth.uid);
        await this.publishReceiving(work, auth.uid);
        return { saved: true };
      },
    );
  }
  async member(auth, requestId, tripId, memberId, remove) {
    return this.mutation(
      auth,
      requestId,
      { operation: "member", tripId, memberId, remove },
      async (work) => {
        const trip = await work.trip(tripId);
        ensure(!trip.deleted, "Trip not found.", 404);
        ensure(
          trip.ownerId === auth.uid,
          "Only the trip creator can change members.",
          403,
        );
        const uid = realId(memberId, auth.uid);
        ensure(uid !== trip.ownerId, "The trip creator must stay in the trip.");
        const oldMembers = [...trip.members];
        if (remove)
          trip.members = trip.members.filter((member) => member !== uid);
        else {
          ensure((await work.profile(uid))?.username, "Member not found.", 404);
          trip.members = [...new Set([...trip.members, uid])];
          ensure(
            trip.members.length <= 12,
            "A trip supports up to 12 members.",
          );
        }
        for (const member of new Set([...oldMembers, ...trip.members])) {
          const state = await work.state(member);
          state.trips = state.trips.filter((item) => item.id !== tripId);
          if (trip.members.includes(member)) {
            state.trips.push(structuredClone(trip));
            for (const other of trip.members)
              if (other !== member) await this.link(work, member, other);
          }
          work.stateChanged(member);
        }
        work.rowChanged(trip);
        return { id: uid, removed: remove };
      },
    );
  }
  async deleteEntity(auth, requestId, type, id) {
    return this.mutation(
      auth,
      requestId,
      { operation: "deleteEntity", type, id },
      async (work) => {
        const state = await work.state(auth.uid);
        if (type === "accounts") {
          const account = activeAccount(state, id);
          ensure(account, "Payment profile not found.", 404);
          account.archived = true;
          if (state.settings.selectedAccountId === id)
            state.settings.selectedAccountId =
              usableAccounts(state)[0]?.id || "";
          await this.publishReceiving(work, auth.uid);
        } else if (type === "friends") {
          const friend = state.friends.find((item) => item.id === id);
          ensure(friend, "Member not found.", 404);
          ensure(
            friend.netCents === 0,
            "Settle this balance before removing the member.",
            409,
          );
          ensure(
            !state.trips.some((trip) => trip.members.includes(id)),
            "Remove this member from shared trips first.",
            409,
          );
          state.friends = state.friends.filter((item) => item.id !== id);
        } else if (type === "categories") {
          ensure(state.categories.length > 1, "Keep at least one category.");
          state.categories = state.categories.filter(
            (category) => category.id !== id,
          );
        } else if (type === "trips") {
          const trip = await work.trip(id);
          ensure(
            trip.ownerId === auth.uid,
            "Only the trip creator can archive the trip.",
            403,
          );
          trip.deleted = true;
          for (const member of trip.members) {
            const other = await work.state(member);
            other.trips = other.trips.filter((item) => item.id !== id);
            work.stateChanged(member);
          }
          work.rowChanged(trip);
        } else if (type === "recurring" || type === "templates") {
          const key = {
            ledgerId: auth.uid,
            [type === "recurring" ? "recurringId" : "templateId"]: id,
          };
          ensure(await work.get(type, key), "Record not found.", 404);
          work.delete(type, key);
        } else throw new ApiError(400, "Unsupported entity type.");
        work.stateChanged(auth.uid);
        return { id, deleted: true };
      },
    );
  }
  async applyFlow(work, flow, id, reverse = false) {
    const pair = await work.pair(flow.creditor, flow.debtor);
    if (reverse) reversePairFlow(pair, flow, id);
    else applyPairFlow(pair, flow, id);
    work.rowChanged(pair);
    const creditor = await this.link(work, flow.creditor, flow.debtor),
      debtor = await this.link(work, flow.debtor, flow.creditor);
    mutateNumber(creditor, "netCents", reverse ? -flow.cents : flow.cents);
    mutateNumber(debtor, "netCents", reverse ? flow.cents : -flow.cents);
    work.stateChanged(flow.creditor);
    work.stateChanged(flow.debtor);
  }
  applyEffect(state, effect, direction = 1) {
    mutateNumber(state.totals, "incomeCents", effect.incomeCents * direction);
    mutateNumber(state.totals, "expenseCents", effect.expenseCents * direction);
    ensure(
      state.totals.incomeCents >= 0 && state.totals.expenseCents >= 0,
      "This operation conflicts with previously erased financial data.",
      409,
    );
    if (effect.expenseCents)
      mutateNumber(
        state.totals.categories,
        effect.category,
        effect.expenseCents * direction,
      );
    state.totals.months[effect.month] ||= { incomeCents: 0, expenseCents: 0 };
    mutateNumber(
      state.totals.months[effect.month],
      "incomeCents",
      effect.incomeCents * direction,
    );
    mutateNumber(
      state.totals.months[effect.month],
      "expenseCents",
      effect.expenseCents * direction,
    );
    if (effect.accountId) {
      const account = state.accounts.find(
        (account) => account.id === effect.accountId,
      );
      ensure(account, "The original payment profile is unavailable.", 409);
      mutateNumber(
        account,
        "balanceCents",
        effect.accountBalanceCents * direction,
      );
      mutateNumber(account, "spentCents", effect.accountSpentCents * direction);
    }
    for (const transfer of effect.transfers || []) {
      const account = state.accounts.find(
        (account) => account.id === transfer.id,
      );
      ensure(account, "The original payment profile is unavailable.", 409);
      mutateNumber(account, "balanceCents", transfer.balanceCents * direction);
    }
  }
  async dailyEffect(work, uid, effect, direction = 1) {
    if (!effect.incomeCents && !effect.expenseCents) return;
    const key = ledgerKey(
      `ANALYTICS#${uid}`,
      `DAY#${String(effect.generation || 0).padStart(6, "0")}#${effect.date}`,
    );
    const row = (await work.get("ledger", key)) || {
      ...key,
      revision: 0,
      date: effect.date,
      incomeCents: 0,
      expenseCents: 0,
      categories: {},
      hours: {},
    };
    mutateNumber(row, "incomeCents", effect.incomeCents * direction);
    mutateNumber(row, "expenseCents", effect.expenseCents * direction);
    if (effect.expenseCents)
      mutateNumber(
        row.categories,
        effect.category,
        effect.expenseCents * direction,
      );
    row.hours[effect.hour] ||= { incomeCents: 0, expenseCents: 0 };
    mutateNumber(
      row.hours[effect.hour],
      "incomeCents",
      effect.incomeCents * direction,
    );
    mutateNumber(
      row.hours[effect.hour],
      "expenseCents",
      effect.expenseCents * direction,
    );
    ensure(
      row.incomeCents >= 0 && row.expenseCents >= 0,
      "Invalid daily totals.",
      409,
    );
    work.rowChanged(row);
  }
  // Old journals may still reference retired content-matching index rows.
  // Delete only their stored pointers; new writes never query or rebuild them.
  removeLegacyDuplicateIndex(work, keys = []) {
    for (const key of keys) if (typeof key?.ledgerId === "string" && key.ledgerId.startsWith("DUPLICATE#") && typeof key.recordId === "string" && key.recordId.startsWith("TX#")) work.delete("ledger", key);
  }
  async transaction(auth, requestId, input, options = {}) {
    const id = options.id || `tx-${crypto.createHash("sha256").update(`${auth.uid}:${requestId}`).digest("hex").slice(0, 32)}`,
      createdAt = new Date().toISOString();
    const mutationInput = { operation: options.replace ? "editTransaction" : "transaction", id: options.id, input: options.hashInput || input };
    // duplicateCheck is accepted only for serialized drafts from older clients.
    // It no longer enables matching; exact request identity remains authoritative.
    const durableRetry = !options.replace && (input.durableRetry === true || input.duplicateCheck === true);
    return this.mutation(
      auth,
      requestId,
      mutationInput,
      async (work) => {
        let previous;
        if (!options.replace) {
          const existing = await work.get("ledger", ledgerKey(`JOURNAL#${id}`));
          if (existing) {
            ensure(existing.creatorId === auth.uid && existing.creationHash === jsonHash(mutationInput), "This request ID was already used for another operation.", 409, "IDEMPOTENCY_CONFLICT");
            return { id };
          }
        }
        if (options.replace) {
          previous = await this.transactionJournal(work, auth, id);
          ensure(!previous.deleted, "Restore this transaction before editing it.", 409);
          await this.reverseTransaction(work, previous);
          // The edit replaces projections in the same database transaction.
          for (const uid of previous.participantIds) work.delete("transactions", { ledgerId: uid, transactionId: previous.sortKeys[uid] });
          if (previous.tripId) work.delete("transactions", { ledgerId: `TRIP#${previous.tripId}`, transactionId: previous.sortKey });
        }
        const ownerState = await work.state(auth.uid),
          type = input.type || "expense";
        ensure(input.ledgerGeneration === undefined || input.ledgerGeneration === (ownerState.generation || 0), "This transaction belongs to a previously erased ledger. Review it before saving again.", 409, "LEDGER_GENERATION_CHANGED");
        ensure(
          ["expense", "income", "settlement", "transfer"].includes(type),
          "Invalid transaction type.",
        );
        const date = input.date || createdAt.slice(0, 10),
          dateValue = new Date(`${date}T00:00:00Z`);
        ensure(
          /^\d{4}-\d{2}-\d{2}$/.test(date) &&
            Number.isFinite(dateValue.getTime()) &&
            dateValue.toISOString().slice(0, 10) === date,
          "Enter a valid transaction date.",
        );
        const settlementTarget =
          type === "settlement"
            ? realId(
                input.targetFriendId ||
                  input.friendId ||
                  (input.paidBy !== "user"
                    ? input.paidBy
                    : input.splits?.[0]?.friendId),
                auth.uid,
              )
            : undefined;
        const settlementFriend =
          type === "settlement"
            ? ownerState.friends.find(
                (friend) => friend.id === settlementTarget,
              )
            : undefined;
        let sourceClaim;
        if (type === "settlement" && input.sourceTransactionId) {
          const source = await work.get("ledger", ledgerKey(`JOURNAL#${input.sourceTransactionId}`));
          ensure(source && !source.deleted && source.effects?.[auth.uid]?.generation === (ownerState.generation || 0), "Split transaction not found.", 404);
          const sourceRow = await work.get("transactions", { ledgerId: auth.uid, transactionId: source.sortKeys[auth.uid] });
          ensure(sourceRow?.data.type === "expense" && sourceRow.data.paidBy === auth.uid, "Only the transaction payer can settle its members.", 403);
          const pair = await work.pair(auth.uid, settlementTarget);
          sourceClaim = (pair.claims || []).filter(claim => claim.id === input.sourceTransactionId && claim.creditor === auth.uid && claim.debtor === settlementTarget).reduce((sum, claim) => sum + claim.remainingCents, 0);
          ensure(sourceClaim > 0, "This member is already settled for this transaction.", 409);
        }
        const total = Math.abs(
          cents(
            input.amount ??
              (sourceClaim ? amount(sourceClaim) : settlementFriend
                ? amount(Math.abs(settlementFriend.netCents))
                : undefined),
          ),
        );
        ensure(total > 0, "Transaction amount must be positive.");
        const title = requiredText(
            input.title || input.expenseName,
            "Transaction title",
            120,
          ),
          category =
            optionalText(input.category, 50) ||
            (type === "income"
              ? "Income"
              : type === "settlement"
                ? "Settlement"
                : "Other");
        const time = optionalText(input.time, 25) || createdAt.slice(11, 16),
          month = date.slice(0, 7);
        const clock = time.match(/^(\d{1,2}):(\d{2})(?::\d{2})?\s*(AM|PM)?$/i);
        let hour = clock ? Number(clock[1]) : Number(createdAt.slice(11, 13));
        if (clock?.[3])
          hour = (hour % 12) + (clock[3].toUpperCase() === "PM" ? 12 : 0);
        ensure(hour >= 0 && hour < 24, "Choose a valid transaction time.");
        let participants = [{ uid: auth.uid, shareCents: 0, paidCents: 0 }],
          flows = [],
          payer = auth.uid,
          signedAmount = type === "income" ? total : -total,
          trip;
        if (type === "expense") {
          const calculated = expenseShares(input, auth.uid);
          participants = calculated.participants;
          payer = calculated.payer;
          flows = debtFlows(participants);
          if (input.tripId) {
            trip = await work.trip(input.tripId);
            ensure(
              !trip.deleted && trip.members.includes(auth.uid),
              "You are not a member of this trip.",
              403,
            );
            ensure(
              participants.every((p) => trip.members.includes(p.uid)),
              "All expense participants must belong to the trip.",
            );
          } else
            for (const participant of participants)
              if (participant.uid !== auth.uid)
                ensure(
                  ownerState.friends.some(
                    (friend) => friend.id === participant.uid,
                  ),
                  "Add this registered member before splitting an expense.",
                );
        } else if (type === "settlement") {
          const target = settlementTarget,
            friend = settlementFriend;
          ensure(
            friend && (sourceClaim || friend.netCents !== 0),
            "There is no outstanding balance with this member.",
          );
          ensure(sourceClaim || friend.netCents > 0, "Only the member owed the combined balance can record a settlement.", 403);
          signedAmount = total;
          payer = signedAmount > 0 ? target : auth.uid;
          participants = [
            { uid: auth.uid, shareCents: 0, paidCents: 0 },
            { uid: target, shareCents: 0, paidCents: 0 },
          ];
          flows = [
            {
              creditor: payer,
              debtor: payer === auth.uid ? target : auth.uid,
              cents: total,
            },
          ];
        }
        const participantProfiles = await Promise.all(participants.map(participant => work.profile(participant.uid)));
        ensure(participantProfiles.every(profile => profile?.username), "Every participant needs a registered profile.");
        // Removed split participants keep a corrected history projection with
        // zero share, including any overpayment left by the original entry.
        if (previous) for (const uid of previous.participantIds) if (!participants.some(p => p.uid === uid)) participants.push({ uid, shareCents: 0, paidCents: 0 });
        // Distinct participant records are independent reads; preloading them
        // removes one network round trip per participant from the write path.
        await Promise.all(participants.map(async participant => {
          const state = await work.state(participant.uid);
          if (type === "income" || (type === "expense" && participant.shareCents))
            await work.get("ledger", ledgerKey(`ANALYTICS#${participant.uid}`, `DAY#${String(state.generation || 0).padStart(6, "0")}#${date}`));
        }));
        const effects = {};
        for (const participant of participants) {
          const state = await work.state(participant.uid);
          let accountId =
            participant.uid === auth.uid
              ? input.upiAccountId ||
                input.accountId ||
                state.settings.selectedAccountId
              : state.settings.selectedAccountId;
          if (accountId)
            ensure(
              activeAccount(state, accountId),
              "Choose an active payment profile.",
              404,
            );
          const effect = {
            incomeCents: type === "income" ? total : 0,
            expenseCents: type === "expense" ? participant.shareCents : 0,
            category,
            month,
            date,
            hour: String(hour).padStart(2, "0"),
            accountId: "",
            accountBalanceCents: 0,
            accountSpentCents: 0,
            generation: state.generation || 0,
          };
          if (type === "transfer") {
            const targetAccount = activeAccount(state, input.toAccountId);
            ensure(
              accountId && targetAccount && targetAccount.id !== accountId,
              "Choose different source and destination profiles for a transfer.",
            );
            effect.transfers = [
              { id: accountId, balanceCents: -total },
              { id: targetAccount.id, balanceCents: total },
            ];
          } else if (accountId) {
            effect.accountId = accountId;
            effect.accountBalanceCents =
              type === "income"
                ? total
                : type === "settlement"
                  ? participant.uid === auth.uid
                    ? signedAmount
                    : -signedAmount
                  : -participant.paidCents;
            effect.accountSpentCents =
              type === "expense" ? participant.paidCents : 0;
          }
          this.applyEffect(state, effect);
          await this.dailyEffect(work, participant.uid, effect);
          work.stateChanged(participant.uid);
          effects[participant.uid] = effect;
        }
        const debtSourceIds = new Set(previous?.debtSourceIds || []);
        for (const flow of flows) {
          if (type === "settlement") {
            const pair = await work.pair(flow.creditor, flow.debtor);
            const before = pair.claims.map(claim => ({ ...claim }));
            applySettlementFlow(pair, flow, id, input.sourceTransactionId);
            for (const claim of before) if (!pair.claims.some(next => next.id === claim.id && next.remainingCents === claim.remainingCents)) debtSourceIds.add(claim.id.startsWith('reversal#') ? claim.id.slice(9) : claim.id);
            work.rowChanged(pair);
            mutateNumber(await this.link(work, flow.creditor, flow.debtor), "netCents", flow.cents);
            mutateNumber(await this.link(work, flow.debtor, flow.creditor), "netCents", -flow.cents);
          } else await this.applyFlow(work, flow, id);
        }
        if (previous) for (const flow of previous.flows) {
          const pair = await work.pair(flow.creditor, flow.debtor);
          pair.claims = pair.claims.map(claim => claim.id === `reversal#${id}` ? { ...claim, id } : claim);
          work.rowChanged(pair);
        }
        if (options.recurring) {
          const expected = options.recurring,
            key = { ledgerId: auth.uid, recurringId: expected.recurringId },
            current = await work.get("recurring", key);
          ensure(
            current?.isActive && current.nextDueDate === expected.nextDueDate,
            "This recurring entry was already processed or changed.",
            409,
          );
          work.put(
            "recurring",
            {
              ...current,
              revision: current.revision + 1,
              nextDueDate: this.nextDue(current.nextDueDate, current.frequency),
              lastProcessedAt: createdAt,
            },
            { revision: current.revision },
          );
        }
        if (trip) {
          trip.totalSpendCents += total;
          work.rowChanged(trip);
          for (const member of trip.members) {
            const state = await work.state(member);
            state.trips = state.trips.map((item) =>
              item.id === trip.id ? structuredClone(trip) : item,
            );
            work.stateChanged(member);
          }
        }
        const sortKey = `TX#${date}#${createdAt}#${id}`,
          pairs = [
            ...new Set([...flows, ...(previous?.flows || [])].map((flow) => pairId(flow.creditor, flow.debtor))),
          ];
        const base = {
          id,
          title,
          subtitle: optionalText(input.subtitle, 120),
          amount: amount(signedAmount),
          type,
          category,
          categoryIcon: optionalText(input.categoryIcon, 80) || "tag",
          date,
          time,
          tripId: trip?.id,
          paidBy: payer,
          splitType: input.splitType || "equal",
          splits:
            type === "expense"
              ? participants.map((p) => ({
                  friendId: p.uid,
                  amount: amount(p.shareCents),
                  paidAmount: amount(p.paidCents),
                }))
              : [],
          settled: flows.length === 0,
          location: optionalText(input.location, 200) || undefined,
          notes: optionalText(input.notes, 1000) || undefined,
          creatorId: auth.uid,
          sourceTransactionId: input.sourceTransactionId,
          toAccountId: type === "transfer" ? input.toAccountId : undefined,
          ...(previous?.clientRequestId || durableRetry ? { clientRequestId: previous?.clientRequestId || requestId } : {}),
        };
        if (previous) this.removeLegacyDuplicateIndex(work, previous.duplicateKeys);
        const sortKeys = {};
        for (const participant of participants) {
          const data = {
            ...base,
            amount:
              type === "settlement"
                ? amount(
                    participant.uid === auth.uid ? signedAmount : -signedAmount,
                  )
                : base.amount,
            upiAccountId:
              effects[participant.uid].accountId ||
              effects[participant.uid].transfers?.[0]?.id ||
              "",
          };
          const userSortKey = `TX#${String(effects[participant.uid].generation).padStart(6, "0")}#${date}#${createdAt}#${id}`;
          sortKeys[participant.uid] = userSortKey;
          work.put("transactions", {
            ledgerId: participant.uid,
            transactionId: userSortKey,
            id,
            data,
            pairIds: pairs,
          });
          work.put("data", {
            userId: participant.uid,
            recordId: `TX#${id}`,
            sortKey: userSortKey,
            id,
          });
        }
        if (trip)
          work.put("transactions", {
            ledgerId: `TRIP#${trip.id}`,
            transactionId: sortKey,
            id,
            data: { ...base, upiAccountId: "" },
            pairIds: pairs,
          });
        work.put(
          "ledger",
          {
            ...ledgerKey(`JOURNAL#${id}`),
            revision: previous ? previous.revision + 1 : 1,
            id,
            creatorId: auth.uid,
            payerId: payer,
            sourceTransactionId: input.sourceTransactionId,
            debtSourceIds: [...debtSourceIds],
            type,
            sortKey,
            sortKeys,
            participantIds: participants.map((p) => p.uid),
            effects,
            flows: [...flows, ...(previous?.flows || []).filter(old => !flows.some(flow => pairId(flow.creditor, flow.debtor) === pairId(old.creditor, old.debtor))).map(old => ({ ...old, cents: 0 }))],
            tripId: trip?.id,
            tripSpendCents: trip ? total : 0,
            createdAt,
            creationHash: previous?.creationHash || jsonHash(mutationInput),
            ...(base.clientRequestId ? { clientRequestId: base.clientRequestId } : {}),
          },
          { revision: previous?.revision || 0 },
        );
        return { id };
      },
      { durable: durableRetry, includeSnapshot: options.includeSnapshot !== false },
    );
  }
  async settle(auth, requestId, body) {
    return this.transaction(auth, requestId, {
      type: "settlement",
      targetFriendId: body.friendId,
      amount: body.amount,
      title: body.title || "Settlement",
      upiAccountId: body.accountId,
      date: body.date,
      sourceTransactionId: body.transactionId,
    });
  }
  async deleteTransaction(auth, requestId, id) {
    return this.mutation(
      auth,
      requestId,
      { operation: "deleteTransaction", id },
      async (work) => {
        const journal = await this.transactionJournal(work, auth, id);
        if (journal.deleted) return { id, deleted: true };
        await this.reverseTransaction(work, journal);
        this.removeLegacyDuplicateIndex(work, journal.duplicateKeys);
        const deletedAt = new Date().toISOString();
        const expiresAt = Math.floor(Date.now() / 1000) + 7 * 86400;
        for (const uid of journal.participantIds) {
          const row = await work.get("transactions", { ledgerId: uid, transactionId: journal.sortKeys[uid] });
          if (row) {
            work.put("transactions", { ...row, deleted: true, deletedAt, expiresAt });
            work.put("ledger", { ...ledgerKey(uid, `BIN#${deletedAt}#${id}`), revision: 1, id, data: row.data, deletedAt, expiresAt, generation: journal.effects[uid]?.generation, ownerId: auth.uid });
          }
          const lookup = await work.get("data", { userId: uid, recordId: `TX#${id}` });
          if (lookup) work.put("data", { ...lookup, expiresAt });
        }
        if (journal.tripId) {
          const row = await work.get("transactions", { ledgerId: `TRIP#${journal.tripId}`, transactionId: journal.sortKey });
          if (row) work.put("transactions", { ...row, deleted: true, deletedAt, expiresAt });
        }
        journal.deleted = true;
        journal.deletedAt = deletedAt;
        journal.expiresAt = expiresAt;
        work.rowChanged(journal);
        return { id, deleted: true };
      },
    );
  }
  async transactionJournal(work, auth, id) {
    const lookup = await work.get("data", { userId: auth.uid, recordId: `TX#${id}` });
    const journal = lookup && await work.get("ledger", ledgerKey(`JOURNAL#${id}`));
    ensure(journal && (!journal.expiresAt || journal.expiresAt > Math.floor(Date.now() / 1000)), "Transaction not found.", 404);
    const row = await work.get("transactions", { ledgerId: auth.uid, transactionId: lookup.sortKey });
    const owner = row?.data.type === "expense" ? journal.payerId || row.data.paidBy : journal.creatorId;
    ensure(owner === auth.uid, "Only the transaction owner can edit, delete or restore it.", 403);
    // Older journals retain this association on their history projection.
    journal.sourceTransactionId ||= row?.data.sourceTransactionId;
    return journal;
  }
  async reverseTransaction(work, journal) {
        for (const [uid, effect] of Object.entries(journal.effects)) {
          const state = await work.state(uid);
          ensure(
            (state.generation || 0) === effect.generation,
            "This transaction belongs to previously erased data.",
            409,
          );
          this.applyEffect(state, effect, -1);
          await this.dailyEffect(work, uid, effect, -1);
          work.stateChanged(uid);
        }
        for (const flow of journal.flows) {
          await this.applyFlow(work, flow, journal.id, true);
          if (journal.sourceTransactionId) {
            const pair = await work.pair(flow.creditor, flow.debtor);
            pair.claims = pair.claims.map(claim => claim.id === `reversal#${journal.id}` ? { ...claim, id: journal.sourceTransactionId } : claim);
            work.rowChanged(pair);
          }
        }
        if (journal.tripId) {
          const trip = await work.trip(journal.tripId);
          trip.totalSpendCents -= journal.tripSpendCents;
          ensure(
            trip.totalSpendCents >= 0,
            "Invalid trip spend reversal.",
            409,
          );
          work.rowChanged(trip);
          for (const member of trip.members) {
            const state = await work.state(member);
            state.trips = state.trips.map((item) =>
              item.id === trip.id ? structuredClone(trip) : item,
            );
            work.stateChanged(member);
          }
        }
  }
  async editTransaction(auth, requestId, id, body) {
    const current = await this.getTransaction(auth, id);
    ensure(!body.type || body.type === current.type, "The transaction type cannot change.");
    return this.transaction(auth, requestId, { ...current, ...body, type: current.type }, { id, replace: true, hashInput: body });
  }
  async restoreTransaction(auth, requestId, id) {
    return this.mutation(auth, requestId, { operation: "restoreTransaction", id }, async work => {
      const journal = await this.transactionJournal(work, auth, id);
      if (!journal.deleted) return { id, restored: true };
      for (const [uid, effect] of Object.entries(journal.effects)) {
        const state = await work.state(uid);
        ensure((state.generation || 0) === effect.generation, "This transaction belongs to an erased ledger.", 409);
        this.applyEffect(state, effect); await this.dailyEffect(work, uid, effect); work.stateChanged(uid);
      }
      for (const flow of journal.flows) {
        if (journal.type === "settlement") {
          const pair = await work.pair(flow.creditor, flow.debtor);
          applySettlementFlow(pair, flow, id, journal.sourceTransactionId);
          work.rowChanged(pair);
          mutateNumber(await this.link(work, flow.creditor, flow.debtor), "netCents", flow.cents);
          mutateNumber(await this.link(work, flow.debtor, flow.creditor), "netCents", -flow.cents);
        } else await this.applyFlow(work, flow, id);
      }
      if (journal.tripId) {
        const trip = await work.trip(journal.tripId);
        ensure(!trip.deleted, "Restore is unavailable for an archived trip.", 409);
        trip.totalSpendCents += journal.tripSpendCents; work.rowChanged(trip);
        for (const uid of trip.members) { const state = await work.state(uid); state.trips = state.trips.map(t => t.id === trip.id ? structuredClone(trip) : t); work.stateChanged(uid); }
      }
      for (const uid of journal.participantIds) {
        const row = await work.get("transactions", { ledgerId: uid, transactionId: journal.sortKeys[uid] });
        ensure(row, "This transaction has expired.", 410);
        const { deleted, deletedAt, expiresAt, ...active } = row; work.put("transactions", active);
        const lookup = await work.get("data", { userId: uid, recordId: `TX#${id}` });
        if (lookup) { const { expiresAt, ...activeLookup } = lookup; work.put("data", activeLookup); }
        work.delete("ledger", ledgerKey(uid, `BIN#${journal.deletedAt}#${id}`));
      }
      if (journal.tripId) {
        const row = await work.get("transactions", { ledgerId: `TRIP#${journal.tripId}`, transactionId: journal.sortKey });
        ensure(row, "This transaction has expired.", 410);
        const { deleted, deletedAt, expiresAt, ...active } = row; work.put("transactions", active);
      }
      delete journal.deleted; delete journal.deletedAt; delete journal.expiresAt;
      this.removeLegacyDuplicateIndex(work, journal.duplicateKeys);
      delete journal.duplicateKeys;
      delete journal.duplicateParticipantIds;
      work.rowChanged(journal); return { id, restored: true };
    });
  }
  async transactionBin(auth) {
    const state = (await this.repo.get("ledger", ledgerKey(auth.uid))) || emptyState(auth.uid);
    const rows = []; let cursor;
    do {
      const page = await this.repo.query("ledger", "ledgerId", auth.uid, { prefix: "BIN#", reverse: true, limit: 100, cursor });
      rows.push(...page.items.filter(row => row.expiresAt > Math.floor(Date.now() / 1000) && row.generation === (state.generation || 0)));
      cursor = page.cursor;
    } while (cursor && rows.length < 500);
    return { items: rows.map(row => ({ ...row.data, paidBy: alias(row.data.paidBy, auth.uid), splits: (row.data.splits || []).map(s => ({ ...s, friendId: alias(s.friendId, auth.uid) })), deletedAt: row.deletedAt, expiresAt: row.expiresAt, canRestore: row.ownerId === auth.uid })) };
  }
  async getTransaction(auth, id) {
    const [lookup, stored] = await Promise.all([
      this.repo.get("data", { userId: auth.uid, recordId: `TX#${id}` }),
      this.repo.get("ledger", ledgerKey(auth.uid)),
    ]);
    ensure(lookup, "Transaction not found.", 404);
    const state = stored || emptyState(auth.uid);
    const row = await this.repo.get("transactions", {
      ledgerId: auth.uid,
      transactionId: lookup.sortKey,
    });
    ensure(
      row &&
        !row.deleted &&
        row.transactionId.startsWith(
          `TX#${String(state.generation || 0).padStart(6, "0")}#`,
        ),
      "Transaction not found.",
      404,
    );
    const pairs = await this.repo.many(
      "ledger",
      (row.pairIds || []).map((id) => ledgerKey(id)),
    );
    const remaining = pairs
      .flatMap((pair) => pair.claims || [])
      .filter((claim) => claim.id === id)
      .reduce((sum, claim) => sum + claim.remainingCents, 0);
    return {
      ...row.data,
      paidBy: alias(row.data.paidBy, auth.uid),
      splits: (row.data.splits || []).map((split) => ({
        ...split,
        friendId: alias(split.friendId, auth.uid),
      })),
      settled: remaining === 0,
      remainingAmount: amount(remaining),
      settlementVector: settlementVector(row.data, pairs, auth.uid),
    };
  }
  async tripHistory(auth, id, options) {
    const trip = await this.repo.get("ledger", ledgerKey(`TRIP#${id}`));
    ensure(
      trip && !trip.deleted && trip.members.includes(auth.uid),
      "Trip not found.",
      404,
    );
    const history = await this.history(auth.uid, { ...options, tripId: id });
    const ids = [
      ...new Set(
        history.items.flatMap((tx) => [
          realId(tx.paidBy, auth.uid),
          ...tx.splits.map((split) => realId(split.friendId, auth.uid)),
        ]),
      ),
    ];
    const profiles = await this.repo.many("data", ids.map(profileKey));
    return {
      ...history,
      profiles: await Promise.all(
        profiles.map((profile) => this.publicProfile(profile)),
      ),
    };
  }
  async analytics(auth, { period = "Month", year, month, date } = {}) {
    await this.bootstrap(auth);
    const state =
      (await this.repo.get("ledger", ledgerKey(auth.uid))) ||
      emptyState(auth.uid);
    const base = `DAY#${String(state.generation || 0).padStart(6, "0")}#`,
      key = `ANALYTICS#${auth.uid}`;
    ensure(
      ["Date", "Month", "Year"].includes(period),
      "Choose a valid analytics period.",
    );
    let rows = [];
    if (period === "Date" && date) {
      ensure(
        /^\d{4}-\d{2}-\d{2}$/.test(date),
        "Choose a valid analytics date.",
      );
      const row = await this.repo.get(
        "ledger",
        ledgerKey(key, `${base}${date}`),
      );
      if (row) rows.push(row);
    } else {
      const y = Number(year || new Date().getFullYear()),
        m = Number(month || new Date().getMonth() + 1);
      ensure(
        Number.isInteger(y) &&
          y >= 1900 &&
          y <= 9999 &&
          Number.isInteger(m) &&
          m >= 1 &&
          m <= 12,
        "Choose a valid analytics month.",
      );
      const prefix =
        period === "Year"
          ? `${base}${y}`
          : `${base}${y}-${String(m).padStart(2, "0")}`;
      let cursor;
      do {
        const page = await this.repo.query("ledger", "ledgerId", key, {
          prefix,
          cursor,
          limit: 100,
        });
        rows.push(...page.items);
        cursor = page.cursor;
      } while (cursor && rows.length <= 366);
    }
    const categories = {},
      totals = { incomeCents: 0, expenseCents: 0 };
    for (const row of rows) {
      mutateNumber(totals, "incomeCents", row.incomeCents);
      mutateNumber(totals, "expenseCents", row.expenseCents);
      for (const [name, value] of Object.entries(row.categories))
        mutateNumber(categories, name, value);
    }
    let points;
    if (period === "Date" && date) {
      let income = 0,
        expense = 0;
      points = [
        {
          key: "start",
          label: "Start",
          fullLabel: date,
          income: 0,
          expense: 0,
        },
        ...Object.entries(rows[0]?.hours || {})
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([hour, value]) => {
            income += value.incomeCents;
            expense += value.expenseCents;
            return {
              key: hour,
              label: `${hour}:00`,
              fullLabel: `${date} ${hour}:00`,
              income: amount(income),
              expense: amount(expense),
            };
          }),
      ];
    } else
      points = rows
        .filter((row) => row.incomeCents || row.expenseCents)
        .map((row) => ({
          key: row.date,
          label: row.date.slice(8),
          fullLabel: row.date,
          income: amount(row.incomeCents),
          expense: amount(row.expenseCents),
        }));
    return {
      categories: Object.fromEntries(
        Object.entries(categories)
          .filter(([, value]) => value > 0)
          .map(([name, value]) => [name, amount(value)]),
      ),
      totalIncome: amount(totals.incomeCents),
      totalExpenses: amount(totals.expenseCents),
      points,
    };
  }
  async erase(auth, requestId, body = {}) {
    return resetSettledHistory(this, Work, auth, requestId, body);
  }
  nextDue(value, frequency) {
    const date = new Date(value);
    ensure(Number.isFinite(date.getTime()), "Invalid due date.");
    if (frequency === "daily" || frequency === "weekly")
      date.setUTCDate(date.getUTCDate() + (frequency === "daily" ? 1 : 7));
    else {
      const day = date.getUTCDate(),
        month = date.getUTCMonth() + (frequency === "yearly" ? 12 : 1);
      date.setUTCDate(1);
      date.setUTCMonth(month);
      date.setUTCDate(
        Math.min(
          day,
          new Date(
            Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0),
          ).getUTCDate(),
        ),
      );
    }
    return date.toISOString();
  }
  async records(auth, type, { due = false, cursor } = {}) {
    await this.bootstrap(auth);
    const items = [];
    let next;
    if (cursor) {
      try {
        next = JSON.parse(Buffer.from(cursor, "base64url").toString());
        ensure(next.ledgerId === auth.uid, "Invalid record cursor.");
      } catch {
        throw new ApiError(400, "Invalid record cursor.");
      }
    }
    const state =
      (await this.repo.get("ledger", ledgerKey(auth.uid))) ||
      emptyState(auth.uid);
    const page = await this.repo.query(type, "ledgerId", auth.uid, {
      cursor: next,
      limit: 100,
    });
    for (const row of page.items)
      if (
        (row.generation || 0) === (state.generation || 0) &&
        (!due ||
          (row.isActive && new Date(row.nextDueDate).getTime() <= Date.now()))
      )
        items.push({
          ...row,
          id: row[type === "recurring" ? "recurringId" : "templateId"],
        });
    return {
      items,
      cursor: page.cursor
        ? Buffer.from(JSON.stringify(page.cursor)).toString("base64url")
        : null,
    };
  }
  async processRecurring(auth, id) {
    const rule = await this.repo.get("recurring", {
        ledgerId: auth.uid,
        recurringId: id,
      }),
      state =
        (await this.repo.get("ledger", ledgerKey(auth.uid))) ||
        emptyState(auth.uid);
    ensure(
      rule?.isActive && (rule.generation || 0) === (state.generation || 0),
      "Recurring rule not found.",
      404,
    );
    ensure(
      new Date(rule.nextDueDate).getTime() <= Date.now(),
      "This recurring entry is not due yet.",
      409,
    );
    const key = `recurring_${crypto.createHash("sha256").update(`${auth.uid}:${id}:${rule.nextDueDate}`).digest("hex")}`;
    return this.transaction(
      auth,
      key,
      {
        title: rule.name,
        amount: rule.amount,
        type: rule.transactionType,
        category: rule.category,
        upiAccountId: rule.upiAccountId,
        date: rule.nextDueDate.slice(0, 10),
        paidBy: "user",
        splitType: "equal",
      },
      { recurring: rule },
    );
  }
  async skipRecurring(auth, requestId, id) {
    return this.mutation(
      auth,
      requestId,
      { operation: "skipRecurring", id },
      async (work) => {
        const key = { ledgerId: auth.uid, recurringId: id },
          rule = await work.get("recurring", key);
        ensure(rule, "Recurring rule not found.", 404);
        work.put(
          "recurring",
          {
            ...rule,
            revision: rule.revision + 1,
            nextDueDate: this.nextDue(rule.nextDueDate, rule.frequency),
          },
          { revision: rule.revision },
        );
        work.stateChanged(auth.uid);
        return { id, skipped: true };
      },
    );
  }
  async history(uid, { cursor, limit = 50, tripId, generation: knownGeneration } = {}) {
    let decoded;
    if (cursor) {
      try {
        decoded = JSON.parse(Buffer.from(cursor, "base64url").toString());
      } catch {
        throw new ApiError(400, "Invalid history cursor.");
      }
      ensure(
        decoded.ledgerId === (tripId ? `TRIP#${tripId}` : uid),
        "Invalid history cursor.",
      );
    }
    const generation = tripId
      ? undefined
      : knownGeneration ?? (await this.repo.get("ledger", ledgerKey(uid)))?.generation ?? 0;
    const wanted = Math.min(Math.max(Number(limit) || 50, 1), 100);
    const rows = [];
    let nextCursor = decoded;
    // Deleted projections must not turn a nonempty ledger into an empty page.
    // Keep the native DynamoDB cursor while filling the requested visible page.
    for (let scan = 0; scan < 20; scan++) {
      const page = await this.repo.query("transactions", "ledgerId", tripId ? `TRIP#${tripId}` : uid, {
        prefix: tripId ? "TX#" : `TX#${String(generation).padStart(6, "0")}#`,
        cursor: nextCursor, limit: wanted - rows.length, reverse: true,
      });
      rows.push(...page.items.filter(row => !row.deleted && !row.clearedFor?.includes(uid)));
      nextCursor = page.cursor;
      if (rows.length >= wanted || !nextCursor) break;
    }
    const pairIds = [...new Set(rows.flatMap((row) => row.pairIds || []))];
    const pairs = await this.repo.many(
      "ledger",
      pairIds.map((id) => ledgerKey(id)),
    );
    const remaining = new Map();
    for (const pair of pairs)
      for (const claim of pair.claims || [])
        remaining.set(
          claim.id,
          (remaining.get(claim.id) || 0) + claim.remainingCents,
        );
    const items = rows.map((row) => ({
      ...row.data,
      paidBy: alias(row.data.paidBy, uid),
      splits: (row.data.splits || []).map((split) => ({
        ...split,
        friendId: alias(split.friendId, uid),
      })),
      settled: !(remaining.get(row.data.id) > 0),
      remainingAmount: amount(remaining.get(row.data.id) || 0),
      settlementVector: settlementVector(row.data, pairs, uid),
    }));
    return {
      items,
      cursor: nextCursor
        ? Buffer.from(JSON.stringify(nextCursor)).toString("base64url")
        : null,
    };
  }
  async sync(uid, after) {
    const state = (await this.repo.get("ledger", ledgerKey(uid))) || emptyState(uid);
    if (/^\d+$/.test(String(after ?? "")) && Number(after) === state.revision && !state.resetting) {
      return { changed: false, revision: state.revision };
    }
    return { changed: true, state: await this.snapshot(uid, state) };
  }
  async initialState(auth) {
    // Read the revision before its profile. A concurrent profile update can
    // then advance the revision, which the next incremental sync will see.
    const state = await this.repo.get("ledger", ledgerKey(auth.uid));
    const profile = await this.bootstrap(auth);
    return this.snapshot(auth.uid, state, profile);
  }
  snapshot(uid, stored, knownProfile) {
    return measure("snapshot", () => this.buildSnapshot(uid, stored, knownProfile));
  }
  async buildSnapshot(uid, stored, knownProfile) {
    const state = stored || (await this.repo.get("ledger", ledgerKey(uid))) || emptyState(uid);
    const [profile, page, profiles] = await Promise.all([
      knownProfile ?? this.repo.get("data", profileKey(uid)),
      this.history(uid, { generation: state.generation || 0 }),
      this.repo.many(
        "data",
        state.friends.map((friend) => profileKey(friend.id)),
      ),
    ]);
    const byId = new Map(profiles.map((profile) => [profile.uid, profile]));
    const friends = await Promise.all(
      state.friends.map(async (friend) => {
        const profile = byId.get(friend.id);
        return {
          id: friend.id,
          name: friend.nickname || profile?.name || "Member",
          handle: profile?.username ? `@${profile.username}` : "",
          avatar: await this.media.resolve(
            friend.avatarRef || profile?.avatarRef || "",
          ),
          ...receivingProfileFields(profile),
          phone: friend.phone || undefined,
          netBalance: amount(friend.netCents),
        };
      }),
    );
    const trips = await Promise.all(
      state.trips.map(async (trip) => ({
        id: trip.id,
        name: trip.name,
        category: trip.category || "trip",
        icon: trip.icon || "Users",
        coverGradient: trip.coverGradient,
        coverImage: await this.media.resolve(trip.coverImageRef || ""),
        startDate: trip.startDate || "",
        endDate: trip.endDate || undefined,
        totalSpend: amount(trip.totalSpendCents),
        ownerId: trip.ownerId,
        members: trip.members.map((member) => alias(member, uid)),
        currency: "INR",
      })),
    );
    const accounts = usableAccounts(state).map(
      ({ balanceCents, spentCents, archived, ...account }) => ({
        ...account,
        balance: amount(balanceCents),
        totalSpent: amount(spentCents),
        isDefault: account.id === state.settings.selectedAccountId,
        isReceivingDefault: account.id === state.settings.receivingAccountId,
      }),
    );
    const totals = state.totals;
    return {
      schemaVersion: 2,
      userId: uid,
      revision: state.revision,
      generation: state.generation || 0,
      ledgerResetId: state.resetting?.id || null,
      resetPolicy: "settled-only",
      accounts,
      friends,
      trips,
      categories: state.categories,
      transactions: page.items,
      transactionCursor: page.cursor,
      settings: state.settings,
      profile: profile ? { ...(await this.publicProfile(profile)), ...receivingProfileFields(profile) } : null,
      summary: {
        totalIncome: amount(totals.incomeCents),
        totalExpenses: amount(totals.expenseCents),
        categories: Object.fromEntries(
          Object.entries(totals.categories).map(([name, value]) => [
            name,
            amount(value),
          ]),
        ),
        months: Object.fromEntries(
          Object.entries(totals.months).map(([month, value]) => [
            month,
            {
              income: amount(value.incomeCents),
              expense: amount(value.expenseCents),
            },
          ]),
        ),
      },
    };
  }
}
