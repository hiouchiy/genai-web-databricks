/**
 * Bedrock-compatible error classes for HTTP error mapping.
 */

export class ThrottlingException extends Error {
  readonly name = 'ThrottlingException';

  constructor(message: string = 'Request rate exceeded') {
    super(message);
    Object.setPrototypeOf(this, ThrottlingException.prototype);
  }
}

export class ValidationException extends Error {
  readonly name = 'ValidationException';

  constructor(message: string = 'Validation error') {
    super(message);
    Object.setPrototypeOf(this, ValidationException.prototype);
  }
}

export class AccessDeniedException extends Error {
  readonly name = 'AccessDeniedException';

  constructor(message: string = 'Access denied') {
    super(message);
    Object.setPrototypeOf(this, AccessDeniedException.prototype);
  }
}

export class ServiceQuotaExceededException extends Error {
  readonly name = 'ServiceQuotaExceededException';

  constructor(message: string = 'Service quota exceeded') {
    super(message);
    Object.setPrototypeOf(this, ServiceQuotaExceededException.prototype);
  }
}

/**
 * Map HTTP status codes and error responses to Bedrock exceptions.
 */
export function mapHttpError(status: number, body?: string): Error {
  const message = body ? `Databricks API error: ${body}` : `HTTP ${status}`;

  switch (status) {
    case 429:
      return new ThrottlingException(message);
    case 400:
      return new ValidationException(message);
    case 401:
    case 403:
      return new AccessDeniedException(message);
    default:
      return new Error(`Databricks API error (${status}): ${message}`);
  }
}
