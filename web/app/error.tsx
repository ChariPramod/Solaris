"use client";
import { CircleAlert } from "lucide-react";
export default function ErrorPage({
  retry,
}: {
  error: Error & { digest?: string };
  retry: () => void;
}) {
  return (
    <main className="empty-state m-10">
      <CircleAlert />
      <h1>The workspace hit a problem.</h1>
      <p>
        Your saved run files have not been changed. Reload the view or use the
        Python reports while this interface is unavailable.
      </p>
      <button className="text-link mt-5" onClick={retry}>
        Try again
      </button>
    </main>
  );
}
