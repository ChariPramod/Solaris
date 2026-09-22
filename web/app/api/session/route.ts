import {
  authenticated,
  checkCloudOrigin,
  createSession,
  SESSION_COOKIE,
  SESSION_SECONDS,
  validAccessKey,
} from "@/lib/cloud-auth";
import { cloudEnabled } from "@/lib/cloud-artifacts";
import { body, failure, json } from "@/lib/http";
import { StoreError } from "@/lib/store";
export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  try {
    if (!cloudEnabled()) return json({ authenticated: true, cloud: false });
    checkCloudOrigin(request);
    return json({ authenticated: authenticated(request), cloud: true });
  } catch (e) {
    return failure(e);
  }
}
export async function POST(request: Request) {
  try {
    if (!cloudEnabled())
      throw new StoreError("Local workspaces do not require sign-in.", 400);
    checkCloudOrigin(request, true);
    const input = await body(request, 2048);
    if (!validAccessKey(input?.key))
      throw new StoreError("The access key is incorrect.", 401);
    const response = json({ authenticated: true });
    response.cookies.set(SESSION_COOKIE, createSession(), {
      httpOnly: true,
      secure: true,
      sameSite: "strict",
      path: "/",
      maxAge: SESSION_SECONDS,
    });
    return response;
  } catch (e) {
    return failure(e);
  }
}
export async function DELETE(request: Request) {
  try {
    checkCloudOrigin(request, true);
    const response = json({ authenticated: false });
    response.cookies.set(SESSION_COOKIE, "", {
      httpOnly: true,
      secure: true,
      sameSite: "strict",
      path: "/",
      maxAge: 0,
    });
    return response;
  } catch (e) {
    return failure(e);
  }
}
