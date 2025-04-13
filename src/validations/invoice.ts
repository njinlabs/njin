import { DateTime } from "luxon";

export function generateInvoice(format: string, number: number) {
  return format
    .replace(/%date:([^%]+)%/g, (_, format) => {
      return DateTime.now().toFormat(format);
    })
    .replace("%number%", `${number}`);
}
