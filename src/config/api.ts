import type { makeModel } from "@njin/core/model";

type ModelFactory = () => Promise<{ default: ReturnType<typeof makeModel> }>;

const api: ModelFactory[] = [];

export default api;
