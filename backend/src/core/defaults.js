export const DEFAULT_CATEGORIES = [
  {
    id: "cat-food",
    name: "Food & Drinks",
    iconKey: "cup-hot",
    color: "#F97316",
  },
  {
    id: "cat-groceries",
    name: "Groceries",
    iconKey: "cart-large-minimalistic",
    color: "#10B981",
  },
  { id: "cat-travel", name: "Travel", iconKey: "bus", color: "#3B82F6" },
  { id: "cat-stay", name: "Stay", iconKey: "home-2", color: "#8B5CF6" },
  { id: "cat-shopping", name: "Shopping", iconKey: "bag-2", color: "#EC4899" },
  {
    id: "cat-work",
    name: "Work",
    iconKey: "case-minimalistic",
    color: "#06B6D4",
  },
  {
    id: "cat-software",
    name: "Software & Tools",
    iconKey: "layers",
    color: "#6366F1",
  },
  { id: "cat-fun", name: "Fun", iconKey: "confetti", color: "#F59E0B" },
  { id: "cat-other", name: "Other", iconKey: "tag", color: "#71717A" },
];
export function emptyState(uid) {
  return {
    ledgerId: uid,
    recordId: "STATE",
    schemaVersion: 2,
    revision: 0,
    accounts: [],
    friends: [],
    trips: [],
    categories: structuredClone(DEFAULT_CATEGORIES),
    settings: {
      selectedAccountId: "",
      themeMode: "dark",
      currency: "INR",
      hideAmounts: false,
      isLiquidGlassEnabled: true,
      selectionStyle: "chips",
      notificationDirection: "bottom",
    },
    totals: { incomeCents: 0, expenseCents: 0, categories: {}, months: {} },
  };
}
