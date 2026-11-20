export class ApiError extends Error {
  constructor(status, message, code = "INVALID_REQUEST", details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}
export function ensure(condition, message, status = 400, code) {
  if (!condition) throw new ApiError(status, message, code);
}
export const requiredText = (value, name, max = 100) => {
  ensure(
    typeof value === "string" &&
      value.trim().length > 0 &&
      value.trim().length <= max,
    `${name} is required (maximum ${max} characters).`,
  );
  return value.trim();
};
export const optionalText = (value, max = 200) =>
  typeof value === "string" ? value.trim().slice(0, max) : "";
