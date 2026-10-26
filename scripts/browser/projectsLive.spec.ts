// T-302: the live run. The real web build on one read of the real vault (projectsLive.py, read-only, kept outside the repo), with
// nothing posted. No real name is written here: what to look for comes from the read itself and from PROJECTS_LIVE_TASKS (the task
// numbers whose runs should show as sessions). Screenshots go to __shots__/t302-live/ (git-ignored: they show real data).
import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { bootProjects, type LiveRead } from './projectsFixture.ts';
import { workFrom } from '../../src/projects/live.ts';

const read: LiveRead = JSON.parse(readFileSync(process.env.PROJECTS_LIVE!, 'utf8'));
const work = workFrom({ nodes: read.nodes, runs: read.runs, tasks: read.tasks });
const tasks = (process.env.PROJECTS_LIVE_TASKS ?? '').split(',').filter(Boolean);
const shot = (page: Page, name: string) => page.screenshot({ path: `__shots__/t302-live/${test.info().project.name}-${name}.png` });
const door = (page: Page, name: string) => page.getByRole('navigation', { name: 'Rooms' }).getByRole('button', { name: new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`) });

test('the live vault: the area rooms, real projects, the named runs as sessions, and real usage', async ({ page }) => {
  test.setTimeout(120_000);
  await bootProjects(page, { live: read });
  await page.goto('/');
  await expect(page.getByRole('navigation', { name: 'Rooms' }).locator('.fd-door')).toHaveCount(work.areas.length);
  expect(work.areas.length).toBe(7);
  await expect(page.getByRole('button', { name: /^Claude: A \d+%/ })).toBeVisible();
  await expect(page.locator('[data-place="front-door"]')).not.toContainText(/\bT-\d{2,}\b/);
  await shot(page, '01-front-door');
  console.log(`live: ${work.areas.length} areas, ${work.projects.length} projects (${work.projects.filter((p) => p.status !== 'archived').length} not archived), ${work.sessions.length} sessions (${work.sessions.filter((s) => s.state === 'running').length} working), ${work.gaps.length} gaps`);
  let i = 2;
  for (const t of tasks) {
    const runs = read.runs.filter((r: any) => r.metadata?.task === t);
    expect(runs.length, `${t} has run notes`).toBeGreaterThan(0);
    for (const r of runs) {
      const s = work.sessions.find((x) => x.id === r.id);
      expect(s, `${t}'s run ${r.path} is a session`).toBeTruthy();
      const p = work.projects.find((x) => x.id === s!.project)!;
      const a = work.areas.find((x) => x.id === p.area)!;
      await page.getByRole('navigation', { name: 'Main navigation' }).getByRole('button', { name: 'Uni', exact: true }).click();
      await door(page, a.name).click();
      await expect(page.locator('.sr-title')).toHaveText(a.name);
      const strip = page.locator('[data-place="project-strip"]');
      await strip.locator(`.ps-tab[data-project="${p.id}"]`).click();
      const sheet = page.getByRole('dialog', { name: p.name });
      const card = sheet.locator(`.pj-session[data-session="${s!.id}"], .pj-earlier li[data-session="${s!.id}"]`);
      if (!(await card.first().isVisible())) await sheet.locator('.pj-earlier summary').click();
      await expect(card.first()).toContainText(s!.ask);
      await expect(sheet).not.toContainText(/\bT-\d{2,}\b|\bmts [a-z0-9]{8}\b/);
      await card.first().scrollIntoViewIfNeeded();
      await shot(page, `0${i++}-${t.toLowerCase()}-${s!.state}`);
      await page.keyboard.press('Escape');
    }
  }
  // the full usage card, from the line
  await page.getByRole('navigation', { name: 'Main navigation' }).getByRole('button', { name: 'Uni', exact: true }).click();
  await page.getByRole('button', { name: /^Claude:/ }).click();
  await expect(page.getByRole('dialog', { name: 'Claude accounts' })).toContainText('Account A');
  await shot(page, `0${i}-usage`);
});
