/**
 * Storyboard for the Purr Projects launch clip.
 *
 * Beats: settle on the board → glide across the header → hover a couple of
 * project cards → scroll to reveal more → land. Eased motion; ~18s.
 *
 * `s` is the helper API from capture.mjs:
 *   s.sleep(ms), s.moveTo(x,y,dur), s.moveToSel(sel,dur), s.hoverSel(sel,dur),
 *   s.click(), s.scrollBy(dy,dur), s.evaluate(fn,...args)
 */
export default async function (s) {
  await s.sleep(1000); // let the board render + cards settle

  // Glide to the header brand (the paw), a beat of "here's what this is".
  await s.moveToSel(".brand svg", 700);
  await s.sleep(700);

  // Sweep across the first row of project cards.
  await s.moveToSel(".card:nth-child(1) h2", 800);
  await s.sleep(650);
  await s.moveToSel(".card:nth-child(2) h2", 700);
  await s.sleep(650);
  await s.moveToSel(".card:nth-child(3) .n", 700);
  await s.sleep(700);

  // Scroll down to reveal the rest of the grid.
  await s.scrollBy(360, 1200);
  await s.sleep(700);

  // Hover the SmolPaws card (the cat one) — a little wink.
  await s.moveToSel(".card:nth-child(5) h2", 800);
  await s.sleep(800);

  // Drift toward a conversation row (the "open in Canvas" affordance).
  await s.moveToSel(".card:nth-child(5) .conv:nth-child(1)", 700);
  await s.sleep(900);

  // Ease back up and rest.
  await s.scrollBy(-360, 1100);
  await s.moveToSel(".refresh", 700);
  await s.sleep(900);
}
