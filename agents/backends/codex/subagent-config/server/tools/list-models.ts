import { listModels } from "../services/model-catalog-service.js";

export async function listModelsTool() {
  return await listModels();
}
