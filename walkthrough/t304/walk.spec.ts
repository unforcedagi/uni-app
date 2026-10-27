// T-304 walkthrough driver: the front door's working mark, a project's sessions, a live session's steps arriving, why one didn't finish,
// what a finished one left, and answering one that needs you. Writes runs/marks.json (seconds into the video at each scene's start) and
// stills runs/NN-*.png; narrate.py cuts and voices them. Made-up world only (scripts/browser/projectsWorld.ts).
import { test, expect, type Page } from '@playwright/test';
import { writeFileSync, mkdirSync } from 'node:fs';
import { bootProjects } from '../../scripts/browser/projectsFixture';

const view = (page: Page) => page.locator('[data-place="session-view"]');
const open = async (page: Page, ask: string) => {
  await page.getByRole('dialog').getByRole('button', { name: new RegExp(`^${ask}`) }).first().click();
  await expect(view(page).locator('.sv-ask')).toHaveText(ask);
};

test('walk', async ({ page }) => {
  const t0 = Date.now();
  const marks: Record<string, number> = {};
  const mark = async (label: string) => {
    marks[label] = (Date.now() - t0) / 1000;
    await page.screenshot({ path: `${R}/${String(Object.keys(marks).length).padStart(2, '0')}-${label}.png` });
  };
  const hold = (ms: number) => page.waitForTimeout(ms);
  const R = test.info().project.outputDir;   // walkthrough/t304/runs
  mkdirSync(R, { recursive: true });
  await bootProjects(page);
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Uni', level: 1 })).toBeVisible();
  await page.evaluate(() => (window as any).__turn('demo-workshop', 'Can the donate page take a monthly amount too?'));
  await expect(page.locator('.fd-door[data-path="Areas/Workshop"] .fd-live')).toHaveText('3 working', { timeout: 20_000 });
  await mark('door');
  await hold(9000);

  await page.locator('.fd-door[data-path="Areas/Workshop"]').click();
  await page.locator('[data-place="project-strip"]').getByRole('button', { name: /Riverbend co-op site/ }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await mark('project');
  await hold(7000);

  await open(page, 'Make the events page read like a noticeboard');
  await mark('live');
  await hold(9000);
  await page.evaluate(() => {
    const f = (window as any).__world.feeds.find((x: any) => x.id === 'feed-events');
    f.content += `- ${new Date().toISOString()} · step · Writing REPORT.md\n- ${new Date().toISOString()} · said · The walkthrough is recorded. Writing the report now.\n`;
  });
  await expect(view(page).locator('.sv-steps li').last()).toContainText('Writing the report now', { timeout: 15_000 });
  await mark('arrives');
  await hold(8000);

  await view(page).getByRole('button', { name: 'Sessions' }).click();
  await open(page, 'Try a donate button');
  await mark('stopped');
  await hold(6000);

  await view(page).getByRole('button', { name: 'Sessions' }).click();
  await open(page, "Rebuild the about page from the coordinator's letter");
  await mark('finished');
  await hold(8000);

  await page.keyboard.press('Escape');
  await page.locator('[data-place="project-strip"]').getByRole('button', { name: /Seed library catalogue/ }).click();
  await open(page, 'Print labels for the spring packets');
  await mark('limit');
  await hold(7000);

  await view(page).getByRole('button', { name: 'Sessions' }).click();
  await open(page, 'Estimate a catalogue from the spreadsheet');
  await mark('needs');
  await hold(8000);
  await view(page).getByRole('button', { name: 'Answer in #workshop' }).click();
  await expect(page.locator('.sr-chat').getByRole('textbox', { name: /^Message / })).toHaveValue(/^About the session on/);
  await mark('answer');
  await hold(8000);
  await mark('end');
  await hold(1000);
  writeFileSync(`${R}/marks.json`, JSON.stringify(marks, null, 1));
});
