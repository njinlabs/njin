import { Meta } from "@njin-types/meta";

export function response<Data>(message: string, data?: Data, meta?: Meta) {
  return {
    message,
    data,
    meta,
  };
}
