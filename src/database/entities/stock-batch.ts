import database from "@njin-modules/database";
import { TransformDate } from "@njin-utils/transform-date";
import { Type } from "class-transformer";
import { DateTime } from "luxon";
import {
  Column,
  Entity,
  EntityManager,
  ManyToOne,
  PrimaryGeneratedColumn,
  type Relation,
} from "typeorm";
import Base from "./base";
import Product from "./product";

@Entity()
export default class StockBatch extends Base {
  @PrimaryGeneratedColumn("uuid")
  public id!: string;

  @Column()
  public productId!: string;

  @ManyToOne(() => Product, (product) => product.batches, {
    eager: true,
    onDelete: "CASCADE",
    nullable: false,
  })
  public product!: Relation<Product>;

  @Column({ type: "timestamptz", nullable: true })
  @TransformDate()
  public receivedAt!: DateTime;

  @Column({ type: "bigint" })
  @Type(() => Number)
  public quantity!: number;

  @Column({ type: "bigint" })
  @Type(() => Number)
  public price!: number;

  public static add(
    records: {
      product: Product;
      quantity: number;
      receivedAt?: DateTime;
      price?: number;
    }[],
    em?: EntityManager,
    update: boolean = false
  ) {
    const callback = async (em: EntityManager) => {
      let oldBatches = update
        ? await em
            .getRepository(StockBatch)
            .createQueryBuilder("batch")
            .where("batch.productId IN (:...ids)", {
              ids: records.map((item) => item.product.id),
            })
            .andWhere("batch.quantity > 0")
            .orderBy("batch.productId", "ASC")
            .addOrderBy("batch.receivedAt", "DESC")
            .setLock("pessimistic_write")
            .getMany()
        : [];

      const batches = records.map(
        ({ product, quantity, receivedAt, price = 0 }) => {
          let batch =
            oldBatches.find((el) => el.productId === product.id) ||
            new StockBatch();

          batch.quantity = (batch.quantity || 0) + quantity;
          batch.product = product;
          if (!batch.price) batch.price = price || product.defaultBasePrice;
          if (!batch.receivedAt)
            batch.receivedAt = receivedAt || DateTime.now();

          return batch;
        }
      );

      await em.getRepository(StockBatch).upsert(batches, ["id"]);
    };

    return em ? callback(em) : database.source.transaction(callback);
  }

  public static sub(
    records: {
      product: Product;
      quantity: number;
    }[],
    mode: "FIFO" | "LIFO",
    em?: EntityManager
  ) {
    const callback = async (em: EntityManager) => {
      const oldBatchesQuery = em
        .getRepository(StockBatch)
        .createQueryBuilder("batch")
        .where("batch.productId IN (:...productIds)", {
          productIds: records.map((item) => item.product.id),
        })
        .andWhere("batch.quantity > 0")
        .setLock("pessimistic_write")
        .orderBy("batch.productId", "ASC");

      if (mode === "FIFO") {
        oldBatchesQuery.addOrderBy("batch.receivedAt", "DESC");
      } else {
        oldBatchesQuery.addOrderBy("batch.receivedAt", "ASC");
      }

      const oldBatches = await oldBatchesQuery.getMany();

      const batches: StockBatch[] = [];

      for (const { product, quantity } of records) {
        const filteredOldBatches = oldBatches.filter(
          (el) => el.productId === product.id && el.quantity > 0
        );

        let diffs = quantity;
        while (diffs > 0) {
          const batch = filteredOldBatches.shift();
          if (!batch) break;

          const amountAfter = batch.quantity - diffs;

          if (amountAfter >= 0) {
            batch.quantity = batch.quantity - quantity;
            diffs = 0;
          } else {
            batch.quantity = 0;
            diffs = Math.abs(amountAfter);
          }

          batches.push(batch);
        }
      }

      await em.getRepository(StockBatch).upsert(batches, ["id"]);
    };

    return em ? callback(em) : database.source.transaction(callback);
  }
}
