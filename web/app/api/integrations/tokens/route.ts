import { z } from "zod";
import { cloudEnabled } from "@/lib/cloud-artifacts";
import { integrationTokens } from "@/lib/integration-tokens";
import { body, failure, json, localRequest } from "@/lib/http";
import { StoreError } from "@/lib/store";
export const dynamic = "force-dynamic";
function authorize(request: Request, write = false) {
  localRequest(request, write);
  if (!cloudEnabled())
    throw new StoreError(
      "API integrations are available in the cloud workspace.",
      400,
    );
}
export async function GET(request: Request) {
  try {
    authorize(request);
    return json({ tokens: await integrationTokens.list() });
  } catch (error) {
    return failure(error);
  }
}
export async function POST(request: Request) {
  try {
    authorize(request, true);
    return json(await integrationTokens.create(await body(request)), 201);
  } catch (error) {
    return failure(error);
  }
}
export async function DELETE(request: Request) {
  try {
    authorize(request, true);
    const input = z
      .object({ id: z.string() })
      .strict()
      .parse(await body(request));
    await integrationTokens.revoke(input.id);
    return json({ revoked: true });
  } catch (error) {
    return failure(error);
  }
}
