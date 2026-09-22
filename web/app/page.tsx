import { Workspace } from "@/components/workspace";
import { CloudAccess } from "@/components/cloud-access";
import { cloudEnabled } from "@/lib/cloud-artifacts";
export const dynamic = "force-dynamic";
export default function Page() {
  const cloud = cloudEnabled();
  return cloud ? (
    <CloudAccess>
      <Workspace cloud />
    </CloudAccess>
  ) : (
    <Workspace />
  );
}
