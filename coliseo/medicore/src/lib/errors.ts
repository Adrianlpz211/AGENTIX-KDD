export class AppError extends Error {
  constructor(public status: number, message: string, public code?: string) {
    super(message);
    this.name = 'AppError';
  }
}

export class UnauthorizedError extends AppError {
  constructor(msg = 'No autorizado') { super(401, msg, 'UNAUTHORIZED'); }
}
export class ForbiddenError extends AppError {
  constructor(msg = 'Prohibido') { super(403, msg, 'FORBIDDEN'); }
}
export class NotFoundError extends AppError {
  constructor(msg = 'No encontrado') { super(404, msg, 'NOT_FOUND'); }
}
export class ConflictError extends AppError {
  constructor(msg = 'Conflicto') { super(409, msg, 'CONFLICT'); }
}
export class RuleViolationError extends AppError {
  constructor(msg: string) { super(422, msg, 'RULE_VIOLATION'); }
}
