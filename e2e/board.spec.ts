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
  await expect(b.getByTestId('live-indicator')).toHaveText('LIVE');

  // Create in A; B sees it in Planning without reloading.
  await a.getByRole('button', { name: 'New glob' }).click();
  await a.getByLabel('Title').fill('Smoke glob');
  await a.getByRole('button', { name: 'Create', exact: true }).click();
  const planningB = b.getByTestId('list-planning');
  await expect(planningB.getByText('Smoke glob')).toBeVisible();
  const card = await a.getByTestId('list-planning').locator('[data-testid^="card-"]').first().getAttribute('data-testid');
  if (card === null) throw new Error('No card');

  // Pick it up from the card in A (its move buttons are the only moves it has); B sees it move.
  await a.getByTestId(card).getByTestId('move-pick_up').click();
  await expect(b.getByTestId('list-doing').getByText('Smoke glob')).toBeVisible();
  await expect(planningB.getByText('Smoke glob')).toHaveCount(0);

  // The glob view shows the new state and the actions now open.
  await b.getByTestId(card).click();
  await expect(b.getByRole('dialog')).toContainText('In progress');
  await expect(b.getByRole('button', { name: 'Pick up' })).toBeVisible();
});
