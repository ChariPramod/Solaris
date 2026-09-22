import { listPresets, savePreset } from "@/lib/workspace-data";
import { body, failure, json, localRequest } from "@/lib/http";
export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  try {
    localRequest(request);
    return json(await listPresets());
  } catch (e) {
    return failure(e);
  }
}
export async function POST(request: Request) {
  try {
    localRequest(request, true);
    return json(await savePreset(await body(request)));
  } catch (e) {
    return failure(e);
  }
}
