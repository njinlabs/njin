import { DateTime } from "luxon";

export function generateInvoice(format: string, number: number) {
  return format
    .replace(/%date:([^%]+)%/g, (_, format) => {
      return DateTime.now().toFormat(format);
    })
    .replace(/%0+%/g, (match) => {
      const zeroCount = match.length - 2;
      return number.toString().padStart(zeroCount, "0");
    });
}
