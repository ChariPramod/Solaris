import { cloudEnabled } from "@/lib/cloud-artifacts";
import { listProjects, saveProject } from "@/lib/client-projects";
import { body, failure, json, localRequest } from "@/lib/http";
import { StoreError } from "@/lib/store";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

function requireCloud() {
  if (!cloudEnabled())
    throw new StoreError("Client projects require the cloud workspace.", 404);
}

export async function GET(request: Request) {
  try {
    localRequest(request);
    requireCloud();
    return json(await listProjects());
  } catch (error) {
    return failure(error);
  }
}

export async function POST(request: Request) {
  try {
    localRequest(request, true);
    requireCloud();
    return json(await saveProject(await body(request, 32 * 1024)));
  } catch (error) {
    return failure(error);
  }
}
