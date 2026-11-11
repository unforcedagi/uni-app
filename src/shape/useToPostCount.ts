// T-335 the shape: the To Post tile's count (and the bar's share of it): the posts that wait for you to review, read as To Post's own
// quiet line read them (src/post/ToPost.tsx ToPostLine): on open, then every five minutes. Uni's vault only (posts are Uni glue).
import { useEffect, useState } from "react";
import { loadPosts } from "../post/ToPost";
import { queue } from "../post/postCore";

export function useToPostCount(vault: string, on: boolean): number {
  const [n, setN] = useState(0);
  useEffect(() => {
    if (!on) { setN(0); return; }
    let live = true;
    const read = () => void loadPosts(vault).then((ps) => { if (live) setN(queue(ps, null).review.length); }).catch(() => {});
    read();
    const t = window.setInterval(read, 5 * 60_000);
    return () => { live = false; window.clearInterval(t); };
  }, [vault, on]);
  return n;
}
