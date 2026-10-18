/**
 * Playback speed (#15): the browser stretches time and keeps the pitch, so a slowed passage
 * is still in tune.
 */

function setRate(element: HTMLMediaElement, rate: number) {
  element.defaultPlaybackRate = rate;
  element.playbackRate = rate;
  element.preservesPitch = true;
}

/**
 * Plays an element at a speed and keeps it there through a new source (a rendition, a
 * version), which resets the element's own. Returns what stops it.
 */
export function holdRate(element: HTMLMediaElement, rate: number): () => void {
  const apply = () => setRate(element, rate);
  apply();
  element.addEventListener("loadedmetadata", apply);
  return () => element.removeEventListener("loadedmetadata", apply);
}

/**
 * Keeps a follower at its leader's speed, as it changes and through the follower's own new
 * sources: the version compared is heard at the same speed. Returns what stops it.
 */
export function followRate(leader: HTMLMediaElement, follower: HTMLMediaElement): () => void {
  const apply = () => setRate(follower, leader.playbackRate);
  apply();
  leader.addEventListener("ratechange", apply);
  follower.addEventListener("loadedmetadata", apply);
  return () => {
    leader.removeEventListener("ratechange", apply);
    follower.removeEventListener("loadedmetadata", apply);
  };
}
