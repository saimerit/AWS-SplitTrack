import crypto from "node:crypto";
import { ApiError, ensure, requiredText, optionalText } from "./errors.js";
import { emptyState } from "./defaults.js";
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
  constructor(repo) {
    this.repo = repo;
    this.cache = new Map();
    this.states = new Map();
    this.changedStates = new Set();
    this.changedRows = new Map();
    this.actions = new Map();
  }
  async get(table, key) {
    const cacheKey = `${table}:${JSON.stringify(key)}`;
    if (!this.cache.has(cacheKey))
      this.cache.set(cacheKey, await this.repo.get(table, key));
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
  delete(table, key) {
    this.actions.set(`${table}:${keyOf(table, key)}`, {
      type: "delete",
      table,
      key,
    });
  }
  async commit() {
    for (const uid of this.changedStates) {
      const state = this.states.get(uid),
        revision = state.revision;
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
      const work = new Work(this.repo),
        state = await work.state(auth.uid);
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
  async mutation(auth, requestId, input, callback) {
    ensure(
      typeof requestId === "string" &&
        /^[A-Za-z0-9_-]{12,100}$/.test(requestId),
      "A valid idempotency-key is required.",
    );
    await this.bootstrap(auth);
    const markerKey = ledgerKey(auth.uid, `REQUEST#${requestId}`),
      hash = jsonHash(input);
    for (let attempt = 0; attempt < 5; attempt++) {
      const marker = await this.repo.get("ledger", markerKey);
      if (marker) {
        ensure(
          marker.hash === hash,
          "This request ID was already used for another operation.",
          409,
          "IDEMPOTENCY_CONFLICT",
        );
        return { result: marker.result, state: await this.snapshot(auth.uid) };
      }
      const work = new Work(this.repo);
      await work.state(auth.uid);
      try {
        const result = await callback(work);
        work.put(
          "ledger",
          {
            ...markerKey,
            revision: 1,
            hash,
            result,
            expiresAt: Math.floor(Date.now() / 1000) + 7 * 86400,
          },
          { revision: 0 },
        );
        await work.commit();
        return { result, state: await this.snapshot(auth.uid) };
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
    const profile = await this.bootstrap(auth);
    return {
      ...(await this.publicProfile(profile)),
      upiId: profile.upiId || undefined,
      email: profile.email,
      username: profile.username,
      displayName: profile.name,
      settings: (
        (await this.repo.get("ledger", ledgerKey(auth.uid))) ||
        emptyState(auth.uid)
      ).settings,
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
    const account =
      selected?.kind === "upi"
        ? selected
        : activeAccount(state, state.settings.receivingAccountId) ||
          usableAccounts(state).find((account) => account.kind === "upi");
    state.settings.receivingAccountId = account?.id || "";
    if (profile) work.put("data", { ...profile, upiId: account?.upiId || "" });
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
  async transaction(auth, requestId, input, options = {}) {
    const id = `tx-${crypto.randomUUID()}`,
      createdAt = new Date().toISOString();
    return this.mutation(
      auth,
      requestId,
      { operation: "transaction", input },
      async (work) => {
        const ownerState = await work.state(auth.uid),
          type = input.type || "expense";
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
        const total = Math.abs(
          cents(
            input.amount ??
              (settlementFriend
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
            friend && friend.netCents !== 0,
            "There is no outstanding balance with this member.",
          );
          ensure(
            total <= Math.abs(friend.netCents),
            "The payment exceeds the outstanding balance.",
          );
          signedAmount = friend.netCents > 0 ? total : -total;
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
        for (const participant of participants)
          ensure(
            (await work.profile(participant.uid))?.username,
            "Every participant needs a registered profile.",
          );
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
        for (const flow of flows) await this.applyFlow(work, flow, id);
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
            ...new Set(flows.map((flow) => pairId(flow.creditor, flow.debtor))),
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
          toAccountId: type === "transfer" ? input.toAccountId : undefined,
        };
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
            revision: 1,
            id,
            creatorId: auth.uid,
            sortKey,
            sortKeys,
            participantIds: participants.map((p) => p.uid),
            effects,
            flows,
            tripId: trip?.id,
            tripSpendCents: trip ? total : 0,
            createdAt,
          },
          { revision: 0 },
        );
        return { id };
      },
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
    });
  }
  async deleteTransaction(auth, requestId, id) {
    return this.mutation(
      auth,
      requestId,
      { operation: "deleteTransaction", id },
      async (work) => {
        const lookup = await work.get("data", {
          userId: auth.uid,
          recordId: `TX#${id}`,
        });
        ensure(lookup, "Transaction not found.", 404);
        const journal = await work.get("ledger", ledgerKey(`JOURNAL#${id}`));
        ensure(journal, "Transaction not found.", 404);
        ensure(
          journal.creatorId === auth.uid,
          "Only the person who added this transaction can delete it.",
          403,
        );
        if (journal.deleted) return { id, deleted: true };
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
        for (const flow of journal.flows)
          await this.applyFlow(work, flow, id, true);
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
        for (const uid of journal.participantIds) {
          const row = await work.get("transactions", {
            ledgerId: uid,
            transactionId: journal.sortKeys[uid],
          });
          if (row) work.put("transactions", { ...row, deleted: true });
        }
        if (journal.tripId) {
          const row = await work.get("transactions", {
            ledgerId: `TRIP#${journal.tripId}`,
            transactionId: journal.sortKey,
          });
          if (row) work.put("transactions", { ...row, deleted: true });
        }
        journal.deleted = true;
        work.rowChanged(journal);
        return { id, deleted: true };
      },
    );
  }
  async getTransaction(auth, id) {
    const lookup = await this.repo.get("data", {
      userId: auth.uid,
      recordId: `TX#${id}`,
    });
    ensure(lookup, "Transaction not found.", 404);
    const state =
      (await this.repo.get("ledger", ledgerKey(auth.uid))) ||
      emptyState(auth.uid);
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
  async erase(auth, requestId) {
    const state =
      (await this.repo.get("ledger", ledgerKey(auth.uid))) ||
      emptyState(auth.uid);
    ensure(
      state.friends.every((friend) => friend.netCents === 0) &&
        state.trips.length === 0,
      "Settle outstanding balances and leave or archive your trips before erasing data.",
      409,
    );
    return this.mutation(
      auth,
      requestId,
      { operation: "erase" },
      async (work) => {
        const latest = await work.state(auth.uid);
        ensure(
          latest.friends.every((friend) => friend.netCents === 0) &&
            latest.trips.length === 0,
          "Your shared balances changed. Settle them before erasing data.",
          409,
        );
        const cleared = emptyState(auth.uid);
        cleared.revision = latest.revision;
        cleared.generation = (latest.generation || 0) + 1;
        // Generation hides prior private history immediately; existing AWS records and other users remain untouched.
        work.states.set(auth.uid, cleared);
        work.stateChanged(auth.uid);
        await this.publishReceiving(work, auth.uid);
        return { erased: true };
      },
    );
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
  async history(uid, { cursor, limit = 50, tripId } = {}) {
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
      : (await this.repo.get("ledger", ledgerKey(uid)))?.generation || 0;
    const page = await this.repo.query(
      "transactions",
      "ledgerId",
      tripId ? `TRIP#${tripId}` : uid,
      {
        prefix: tripId ? "TX#" : `TX#${String(generation).padStart(6, "0")}#`,
        cursor: decoded,
        limit: Math.min(Math.max(Number(limit) || 50, 1), 100),
        reverse: true,
      },
    );
    const rows = page.items.filter((row) => !row.deleted),
      pairIds = [...new Set(rows.flatMap((row) => row.pairIds || []))];
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
    }));
    return {
      items,
      cursor: page.cursor
        ? Buffer.from(JSON.stringify(page.cursor)).toString("base64url")
        : null,
    };
  }
  async snapshot(uid) {
    const [stored, profile, page] = await Promise.all([
      this.repo.get("ledger", ledgerKey(uid)),
      this.repo.get("data", profileKey(uid)),
      this.history(uid),
    ]);
    const state = stored || emptyState(uid),
      profiles = await this.repo.many(
        "data",
        state.friends.map((friend) => profileKey(friend.id)),
      ),
      byId = new Map(profiles.map((profile) => [profile.uid, profile]));
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
          upiId: profile?.upiId || undefined,
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
      accounts,
      friends,
      trips,
      categories: state.categories,
      transactions: page.items,
      transactionCursor: page.cursor,
      settings: state.settings,
      profile: profile ? await this.publicProfile(profile) : null,
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
