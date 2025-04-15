import { faker } from "@faker-js/faker";
import { currency } from "@njin-utils/currency";
import { calculateFee } from "@njin-utils/fee";
import { expect, test } from "bun:test";

test("Calculate fee", () => {
  const data = Array(50)
    .fill(faker.number.int({ min: 1 }))
    .map((value: number) => {
      const total = currency(value);
      const shipping = currency(faker.number.int({ min: 1 }));
      const all = total.add(shipping).add(total.percentage(5));

      return {
        total,
        fees: [
          {
            name: "Ongkos Kirim",
            amount: shipping,
          },
          {
            name: "Biaya Admin",
            percentage: {
              value: 5,
            },
          },
          {
            name: "PPN",
            percentage: {
              value: 11,
              fromGrandTotal: true,
            },
          },
        ],
        expected: all.add(all.percentage(11)),
      };
    });

  data.forEach((item) => {
    const { total } = calculateFee(item.total, item.fees);
    expect(total.equalsTo(item.expected)).toBe(true);
  });
});
