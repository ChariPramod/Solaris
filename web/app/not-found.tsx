import Link from "next/link";
export default function NotFound() {
  return (
    <main className="empty-state m-10">
      <h1>This page is not available.</h1>
      <p>Your evaluation library is still here.</p>
      <Link className="text-link mt-5" href="/">
        Return to evaluations
      </Link>
    </main>
  );
}
