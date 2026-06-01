import { test, expect, _electron as electron } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

test('real Electron app opens a local project and reviews a record', async () => {
  const createdProjectPath = path.resolve('test-fixtures/local-projects/e2e-created-project');
  fs.rmSync(createdProjectPath, { recursive: true, force: true });
  const appEnv = path.resolve('test-fixtures/e2e.env');
  const electronApp = await electron.launch({
    args: ['.'],
    env: {
      ...process.env,
      REVIEW_ASSISTANT_APP_ENV: appEnv,
      REVIEW_ASSISTANT_COPILOT_COMMAND: process.execPath,
      REVIEW_ASSISTANT_COPILOT_COMMAND_ARGS: path.resolve('test-fixtures/fake-copilot.mjs')
    }
  });
  const page = await electronApp.firstWindow();

  await expect(page.getByText('Version')).toBeVisible();
  await page.getByLabel('Current project').selectOption('sample-project');
  await page.getByRole('button', { name: 'valid-record', exact: true }).click();
  await expect(page.getByText('Record passes schema validation.')).toBeVisible();
  await expect(page.getByText('How do I run the harness?')).toBeVisible();
  const arrayItemSummaryMetrics = await page.evaluate(() => {
    const summary = document.querySelector('.collapsible-node summary');
    const summaryContent = document.querySelector('.array-item-summary');
    const identifier = document.querySelector('.array-item-identifier');
    if (!(summary instanceof HTMLElement) || !(summaryContent instanceof HTMLElement) || !(identifier instanceof HTMLElement)) {
      throw new Error('Array item summary elements were not rendered.');
    }
    const summaryRect = summary.getBoundingClientRect();
    const contentRect = summaryContent.getBoundingClientRect();
    const identifierRect = identifier.getBoundingClientRect();
    return {
      contentTop: contentRect.top,
      identifierHeight: identifierRect.height,
      identifierTop: identifierRect.top,
      summaryHeight: summaryRect.height
    };
  });
  expect(Math.abs(arrayItemSummaryMetrics.contentTop - arrayItemSummaryMetrics.identifierTop)).toBeLessThanOrEqual(1);
  expect(arrayItemSummaryMetrics.summaryHeight).toBeLessThanOrEqual(arrayItemSummaryMetrics.identifierHeight * 1.5);

  await page.getByLabel('Message GitHub Copilot').fill('summarize this record');
  await page.getByRole('button', { name: 'Send' }).click();
  await expect(page.getByText('Record question: How do I run the harness?')).toBeVisible();

  await page.getByRole('button', { name: 'Create project' }).click();
  await expect(page.getByRole('dialog', { name: 'Create project' })).toBeVisible();
  await page.getByLabel('Project name').fill('e2e-created-project');
  await page.getByRole('button', { name: 'Create', exact: true }).click();
  await expect(page.getByText('e2e-created-project records')).toBeVisible();
  expect(fs.existsSync(path.join(createdProjectPath, '_schema.json'))).toBe(true);

  await electronApp.close();
  fs.rmSync(createdProjectPath, { recursive: true, force: true });
});

test('records list scroll area reaches the records column edge and keeps content clear of the scrollbar', async () => {
  const appEnv = path.resolve('.env');
  const electronApp = await electron.launch({
    args: ['.'],
    env: {
      ...process.env,
      REVIEW_ASSISTANT_APP_ENV: appEnv,
      REVIEW_ASSISTANT_COPILOT_COMMAND: process.execPath,
      REVIEW_ASSISTANT_COPILOT_COMMAND_ARGS: path.resolve('test-fixtures/fake-copilot.mjs')
    }
  });
  const page = await electronApp.firstWindow();
  await page.setViewportSize({ width: 900, height: 560 });

  await page.getByLabel('Current project').selectOption('agent01');
  await expect(page.getByRole('button', { name: 'q16', exact: true })).toBeVisible();

  const metrics = await page.evaluate(() => {
    const recordsColumn = document.querySelector('.records');
    const recordsList = document.querySelector('.records-list-container');
    const firstRecordButton = document.querySelector('.record-button');
    if (!(recordsColumn instanceof HTMLElement) || !(recordsList instanceof HTMLElement) || !(firstRecordButton instanceof HTMLElement)) {
      throw new Error('Records layout elements were not rendered.');
    }
    const columnRect = recordsColumn.getBoundingClientRect();
    const listRect = recordsList.getBoundingClientRect();
    const buttonRect = firstRecordButton.getBoundingClientRect();
    return {
      bodyClientHeight: document.body.clientHeight,
      bodyScrollHeight: document.body.scrollHeight,
      buttonRight: buttonRect.right,
      columnRight: columnRect.right,
      listClientHeight: recordsList.clientHeight,
      listRight: listRect.right,
      listScrollHeight: recordsList.scrollHeight
    };
  });

  expect(metrics.listScrollHeight).toBeGreaterThan(metrics.listClientHeight);
  expect(metrics.bodyScrollHeight).toBe(metrics.bodyClientHeight);
  expect(Math.abs(metrics.listRight - metrics.columnRight)).toBeLessThanOrEqual(1);
  expect(metrics.columnRight - metrics.buttonRight).toBeGreaterThanOrEqual(20);

  await electronApp.close();
});

test('real Electron app lets Copilot read the displayed record through the local tool', async () => {
  const appEnv = path.resolve('.env');
  const electronApp = await electron.launch({
    args: ['.'],
    env: {
      ...process.env,
      REVIEW_ASSISTANT_APP_ENV: appEnv,
      REVIEW_ASSISTANT_COPILOT_COMMAND: process.execPath,
      REVIEW_ASSISTANT_COPILOT_COMMAND_ARGS: path.resolve('test-fixtures/fake-copilot.mjs'),
      FAKE_COPILOT_REQUIRE_REVIEW_ASSISTANT_TOOLS: '1'
    }
  });
  const page = await electronApp.firstWindow();

  await page.getByLabel('Current project').selectOption('agent01');
  await page.getByRole('button', { name: 'q07', exact: true }).click();
  await expect(page.getByText('What is the E2E flow of a purchase - technically?', { exact: true })).toBeVisible();

  await page.getByLabel('Message GitHub Copilot').fill('what is the persona and question?');
  await page.getByRole('button', { name: 'Send' }).click();

  await expect(page.getByText('Record persona: developer')).toBeVisible();
  await expect(page.getByText('Record question: What is the E2E flow of a purchase - technically?')).toBeVisible();

  await electronApp.close();
});

test('real Electron app configures feedback and shows subsequent users collapsed history', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'review-assistant-feedback-'));
  const projectPath = path.join(tempRoot, 'feedback-project');
  const appEnv = path.join(tempRoot, 'app.env');
  fs.mkdirSync(projectPath);
  fs.writeFileSync(
    path.join(projectPath, '_schema.json'),
    JSON.stringify({ type: 'object', properties: { answer: { type: 'string' } }, required: ['answer'] }, null, 2)
  );
  fs.writeFileSync(path.join(projectPath, 'record-1.json'), JSON.stringify({ answer: 'Initial answer' }, null, 2));
  fs.writeFileSync(appEnv, `LOCAL_PATH=${tempRoot}\nUSERNAME=first@example.com\n`);

  const launch = () =>
    electron.launch({
      args: ['.'],
      env: {
        ...process.env,
        REVIEW_ASSISTANT_APP_ENV: appEnv,
        REVIEW_ASSISTANT_COPILOT_COMMAND: process.execPath,
        REVIEW_ASSISTANT_COPILOT_COMMAND_ARGS: path.resolve('test-fixtures/fake-copilot.mjs')
      }
    });

  const firstApp = await launch();
  const firstPage = await firstApp.firstWindow();
  await firstPage.getByLabel('Current project').selectOption('feedback-project');
  await expect(firstPage.getByLabel('Current feedback username')).toContainText('first@example.com');
  await firstPage.getByRole('button', { name: 'Configure' }).click();
  await firstPage.getByLabel('Answer feedback mode').selectOption('good_fair_bad');
  await firstPage.getByLabel('Answer comment').check();
  await firstPage.getByRole('button', { name: 'Save' }).click();
  await firstPage.getByRole('button', { name: 'record-1', exact: true }).click();
  await firstPage.getByRole('radio', { name: 'Good' }).check();
  await firstPage.getByLabel('Comment').fill('Looks good to me');
  await firstPage.getByRole('button', { name: 'Submit feedback' }).click();
  await expect(firstPage.getByText('History (1)')).toBeVisible();
  await firstApp.close();

  fs.writeFileSync(appEnv, `LOCAL_PATH=${tempRoot}\nUSERNAME=second@example.com\n`);
  const secondApp = await launch();
  const secondPage = await secondApp.firstWindow();
  await secondPage.getByLabel('Current project').selectOption('feedback-project');
  await expect(secondPage.getByLabel('Current feedback username')).toContainText('second@example.com');
  await secondPage.getByRole('button', { name: 'record-1', exact: true }).click();
  await expect(secondPage.getByText('History (1)')).toBeVisible();
  await expect(secondPage.getByText('Looks good to me')).not.toBeVisible();
  await secondPage.getByText('History (1)').click();
  await expect(secondPage.getByText('Looks good to me')).toBeVisible();

  await secondPage.getByRole('button', { name: 'Configure' }).click();
  await secondPage.getByLabel('Answer editable').check();
  await secondPage.getByRole('button', { name: 'Save' }).click();
  await expect(secondPage.getByLabel('Edit')).toBeVisible();
  await secondPage.getByLabel('Edit').fill('Second user edit');
  await secondPage.getByRole('button', { name: 'Submit feedback' }).click();
  await expect(secondPage.getByText('History (2)')).toBeVisible();

  await secondApp.close();
  fs.rmSync(tempRoot, { recursive: true, force: true });
});
