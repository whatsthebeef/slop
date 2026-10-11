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
  // A new user lands on the first-board form; anyone already on a board lands on it.
  await expect(page).not.toHaveURL(/\/login$/);
  return page;
};

test('a glob created and moved on one board shows up live on another', async ({ browser }) => {
  const a = await signIn(browser, owner);
  await expect(a.getByRole('heading', { name: 'Create your first board' })).toBeVisible();
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
  await expect(b.getByTestId('board')).toHaveAttribute('data-live', 'live');

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
  await expect(b.getByTestId('glob-page')).toContainText('In progress');
  await expect(b.getByRole('button', { name: 'Pick up' })).toBeVisible();
});

test('the filter pane narrows the cards by category and glob ID, and Clear restores them', async ({
  browser,
}) => {
  const page = await signIn(browser, `filter-${unique}@example.com`);
  await page.getByLabel('Name', { exact: true }).fill(`Filter ${unique}`);
  await page.getByRole('button', { name: 'Create board' }).click();
  await expect(page.getByRole('heading', { name: `Filter ${unique}` })).toBeVisible();

  const create = async (title: string) => {
    await page.getByRole('button', { name: 'New glob' }).click();
    await page.getByLabel('Title').fill(title);
    await page.getByRole('button', { name: 'Create', exact: true }).click();
    await expect(page.getByTestId('list-planning').getByText(title)).toBeVisible();
  };
  await create('Alpha glob');
  await create('Beta glob');

  // The filter button sits immediately left of the chat button.
  const filter = page.getByTestId('filter-toggle');
  const chat = page.getByTestId('chat-toggle');
  const [f, c] = await Promise.all([filter.boundingBox(), chat.boundingBox()]);
  expect(f !== null && c !== null && f.x < c.x && c.x - (f.x + f.width) < 12).toBe(true);

  const planning = page.getByTestId('list-planning');
  await filter.click();
  await expect(page.getByTestId('filter-pane')).toHaveAttribute('data-open', 'true');
  await page.getByTestId('filter-category-bug').click();
  await expect(page).toHaveURL(/category=bug/);
  await expect(planning.getByText('Alpha glob')).toHaveCount(0);
  await expect(planning.getByTestId('no-match')).toBeVisible();
  await expect(filter.getByTestId('filter-active')).toBeVisible();

  await page.getByTestId('filter-category-bug').click();
  await page.getByTestId('filter-id').fill('zzz');
  await expect(planning.getByText('Alpha glob')).toHaveCount(0);

  await page.getByTestId('filter-clear').click();
  await expect(planning.getByText('Alpha glob')).toBeVisible();
  await expect(planning.getByText('Beta glob')).toBeVisible();
  await expect(page).not.toHaveURL(/category=|id=/);
});
