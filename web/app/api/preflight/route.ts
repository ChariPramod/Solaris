import { checkReadiness } from "@/lib/harness";
import { body, failure, json, localRequest } from "@/lib/http";
export async function POST(request: Request) {
  try {
    localRequest(request, true);
    return json(await checkReadiness(await body(request)));
  } catch (e) {
    return failure(e);
  }
}
