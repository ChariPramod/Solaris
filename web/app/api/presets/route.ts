import { cloudEnabled } from "@/lib/cloud-artifacts";
import {
  listPresets as listCloudPresets,
  savePreset as saveCloudPreset,
} from "@/lib/cloud-workspace-data";
import { listPresets, savePreset } from "@/lib/workspace-data";
import { body, failure, json, localRequest } from "@/lib/http";
export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  try {
    localRequest(request);
    return json(await (cloudEnabled() ? listCloudPresets() : listPresets()));
  } catch (e) {
    return failure(e);
  }
}
export async function POST(request: Request) {
  try {
    localRequest(request, true);
    return json(
      await (cloudEnabled() ? saveCloudPreset : savePreset)(
        await body(request),
      ),
    );
  } catch (e) {
    return failure(e);
  }
}
