import { expect, test } from '@playwright/test';
import type { Browser, Page } from '@playwright/test';

const unique = Date.now().toString(36);
const owner = `owner-${unique}@example.com`;
const teammate = `mate-${unique}@example.com`;

const signIn = async (browser: Browser, email: string): Promise<Page> => {
  const page = await (await browser.newContext()).newPage();
  await page.goto('/login');
  await page.getByLabel('Email').fill(email);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Your boards' })).toBeVisible();
  return page;
};

/** Drags in small steps so dnd-kit's pointer sensor sees a real drag. */
const dragTo = async (page: Page, from: string, to: string) => {
  const source = await page.getByTestId(from).boundingBox();
  const target = await page.getByTestId(to).boundingBox();
  if (source === null || target === null) throw new Error('Nothing to drag');
  await page.mouse.move(source.x + 20, source.y + 20);
  await page.mouse.down();
  await page.mouse.move(source.x + 40, source.y + 40, { steps: 5 });
  await page.mouse.move(target.x + target.width / 2, target.y + 80, { steps: 15 });
  await page.mouse.up();
};

test('a glob created and moved on one board shows up live on another', async ({ browser }) => {
  const a = await signIn(browser, owner);
  await a.getByLabel('Name', { exact: true }).fill(`Smoke ${unique}`);
  await a.getByRole('button', { name: 'Create board' }).click();
  await expect(a.getByRole('heading', { name: `Smoke ${unique}` })).toBeVisible();
  const boardUrl = a.url();

  await a.getByRole('link', { name: 'Settings' }).click();
  await a.getByPlaceholder('email').fill(teammate);
  await a.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(a.getByText(teammate)).toBeVisible();

  const b = await signIn(browser, teammate);
  await b.goto(boardUrl);
  await a.goto(boardUrl);
  await expect(b.getByTitle('Live')).toBeVisible();

  // Create in A; B sees it in Planning without reloading.
  await a.getByRole('button', { name: 'New glob' }).click();
  await a.getByLabel('Title').fill('Smoke glob');
  await a.getByRole('button', { name: 'Create', exact: true }).click();
  const planningB = b.getByTestId('list-planning');
  await expect(planningB.getByText('Smoke glob')).toBeVisible();
  const card = await a.getByTestId('list-planning').locator('[data-testid^="card-"]').first().getAttribute('data-testid');
  if (card === null) throw new Error('No card');

  // Drag to Doing in A and choose Pick up; B sees it move.
  await dragTo(a, card, 'list-doing');
  const move = a.getByRole('dialog', { name: /^Move .* to Doing$/ });
  await expect(move).toBeVisible();
  // dnd-kit swallows clicks until the event loop turns after a drop.
  await a.waitForTimeout(50);
  await move.getByRole('button', { name: /^Pick up/ }).click();
  await expect(b.getByTestId('list-doing').getByText('Smoke glob')).toBeVisible();
  await expect(planningB.getByText('Smoke glob')).toHaveCount(0);

  // The glob view shows the new state and the actions now open.
  await b.getByTestId(card).click();
  await expect(b.getByRole('dialog')).toContainText('In progress');
  await expect(b.getByRole('button', { name: 'Pick up' })).toBeVisible();
});
