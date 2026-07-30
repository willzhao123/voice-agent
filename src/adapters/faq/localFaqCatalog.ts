import { readFile } from "node:fs/promises";

import {
  parseApprovedFaqCatalog,
  type ApprovedFaqCatalog,
} from "../../application/voiceFaqRouter.js";

export async function loadApprovedFaqCatalog(
  path: string,
): Promise<ApprovedFaqCatalog> {
  const contents = await readFile(path, "utf8");
  return parseApprovedFaqCatalog(JSON.parse(contents) as unknown);
}
