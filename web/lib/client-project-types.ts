export const CLIENT_PROJECT_STATUSES = [
  "active",
  "review",
  "delivered",
  "archived",
] as const;

export type ClientProjectStatus = (typeof CLIENT_PROJECT_STATUSES)[number];

export const CLIENT_PROJECT_STATUS_LABELS: Record<ClientProjectStatus, string> =
  {
    active: "Active",
    review: "In review",
    delivered: "Delivered",
    archived: "Archived",
  };

export type ClientProject = {
  id: string;
  revision: number;
  name: string;
  client: string;
  /** Manual delivery tracking; independent of evaluation or quality-gate results. */
  status: ClientProjectStatus;
  notes: string;
  runIds: string[];
  createdAt: string;
  updatedAt: string;
};
