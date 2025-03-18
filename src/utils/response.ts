export type Meta = {
  pagination?: {
    page: number;
    perPage: number;
    totalPages: number;
    totalItems: number;
  };
};

export function errorResponse<Data = any>(
  e: Error & {
    data?: Data;
  }
) {
  return {
    message: e.message,
    data: e.data,
  };
}

export function successResponse<Data>(
  message: string,
  data?: Data,
  meta?: Meta
) {
  return {
    message,
    data,
    meta,
  };
}
