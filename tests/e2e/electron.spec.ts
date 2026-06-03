import { test, expect, _electron as electron } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const fakeProviderEnv = {
  REVIEW_ASSISTANT_AGENT_PROVIDER_MODULE: path.resolve('test-fixtures/fake-copilot-sdk-provider.mjs')
};

test('real Electron app opens a local project and reviews a record', async () => {
  const createdProjectPath = path.resolve('test-fixtures/local-projects/e2e-created-project');
  fs.rmSync(createdProjectPath, { recursive: true, force: true });
  const appEnv = path.resolve('test-fixtures/e2e.env');
  const electronApp = await electron.launch({
    args: ['.'],
    env: {
      ...process.env,
      REVIEW_ASSISTANT_APP_ENV: appEnv,
      ...fakeProviderEnv
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
  await expect(page.getByRole('heading', { name: 'records' })).toBeVisible();
  await expect.poll(() => fs.existsSync(path.join(createdProjectPath, '_schema.json'))).toBe(true);

  await electronApp.close();
  fs.rmSync(createdProjectPath, { recursive: true, force: true });
});

test('real Electron app auto-opens the first project and record by default', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'review-assistant-autoopen-'));
  const projectPath = path.join(tempRoot, 'auto-project');
  const appEnv = path.join(tempRoot, 'app.env');
  fs.mkdirSync(projectPath);
  fs.writeFileSync(
    path.join(projectPath, '_schema.json'),
    JSON.stringify({ type: 'object', properties: { question: { type: 'string' } }, required: ['question'] }, null, 2)
  );
  fs.writeFileSync(path.join(projectPath, 'only-record.json'), JSON.stringify({ question: 'Auto opened question?' }, null, 2));
  fs.writeFileSync(appEnv, `LOCAL_PATH=${tempRoot}\n`);
  const electronApp = await electron.launch({
    args: ['.'],
    env: {
      ...process.env,
      REVIEW_ASSISTANT_APP_ENV: appEnv,
      ...fakeProviderEnv
    }
  });
  const page = await electronApp.firstWindow();
  try {
    await expect(page.getByLabel('Current project')).toHaveValue('auto-project');
    await expect(page.getByText('Auto opened question?')).toBeVisible();
    await expect(page.getByText('Record passes schema validation.')).toBeVisible();
  } finally {
    await electronApp.close();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('records list scroll area reaches the records column edge and keeps content clear of the scrollbar', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'review-assistant-scroll-'));
  const projectPath = path.join(tempRoot, 'scroll-project');
  const appEnv = path.join(tempRoot, 'app.env');
  fs.mkdirSync(projectPath);
  fs.writeFileSync(
    path.join(projectPath, '_schema.json'),
    JSON.stringify({ type: 'object', properties: { question: { type: 'string' } }, required: ['question'] }, null, 2)
  );
  for (let index = 1; index <= 24; index += 1) {
    const id = `q${String(index).padStart(2, '0')}`;
    fs.writeFileSync(path.join(projectPath, `${id}.json`), JSON.stringify({ question: `Question ${index}` }, null, 2));
  }
  fs.writeFileSync(appEnv, `LOCAL_PATH=${tempRoot}\nAUTO_OPEN_FIRST=false\n`);
  const electronApp = await electron.launch({
    args: ['.'],
    env: {
      ...process.env,
      REVIEW_ASSISTANT_APP_ENV: appEnv,
      ...fakeProviderEnv
    }
  });
  const page = await electronApp.firstWindow();
  try {
    await page.setViewportSize({ width: 900, height: 560 });

    await page.getByLabel('Current project').selectOption('scroll-project');
    await expect(page.getByRole('button', { name: 'q01', exact: true })).toBeVisible();

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
  } finally {
    await electronApp.close();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('workspace keeps filling the window after collapsible sections are toggled', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'review-assistant-layout-'));
  fs.cpSync(path.resolve('test-fixtures/local-projects/sample-project'), path.join(tempRoot, 'sample-project'), { recursive: true });
  const appEnv = path.join(tempRoot, 'app.env');
  fs.writeFileSync(appEnv, `LOCAL_PATH=${tempRoot}\nUSERNAME=layout@example.com\nAUTO_OPEN_FIRST=false\n`);
  const electronApp = await electron.launch({
    args: ['.'],
    env: {
      ...process.env,
      REVIEW_ASSISTANT_APP_ENV: appEnv,
      ...fakeProviderEnv
    }
  });
  const page = await electronApp.firstWindow();
  try {
    await page.setViewportSize({ width: 1600, height: 900 });
    await page.getByLabel('Current project').selectOption('sample-project');
    await page.getByRole('button', { name: 'valid-record', exact: true }).click();
    await expect(page.getByText('How do I run the harness?')).toBeVisible();
    await page.getByRole('button', { name: 'Configure' }).click();
    await page.getByLabel('Evidence > Id feedback mode').selectOption('stars_5');
    await page.getByRole('dialog', { name: 'Feedback configuration' }).getByRole('button', { name: 'Save' }).click();
    await expect(page.getByRole('dialog', { name: 'Feedback configuration' })).toBeHidden();

    const toggledCount = await page.locator('.details details').evaluateAll((items) => {
      for (const item of items) {
        item.removeAttribute('open');
      }
      for (const item of items) {
        item.setAttribute('open', '');
      }
      return items.length;
    });
    expect(toggledCount).toBeGreaterThan(0);
    await page.locator('label.feedback-option').filter({ hasText: /^★★★★$/ }).click();

    const metrics = await page.evaluate(() => {
      const app = document.querySelector('.app');
      const columns = document.querySelector('.columns');
      const footer = document.querySelector('.app-footer');
      if (!(app instanceof HTMLElement) || !(columns instanceof HTMLElement) || !(footer instanceof HTMLElement)) {
        throw new Error('Workspace layout elements were not rendered.');
      }
      const appRect = app.getBoundingClientRect();
      const columnsRect = columns.getBoundingClientRect();
      const footerRect = footer.getBoundingClientRect();
      return {
        appBottom: appRect.bottom,
        columnsBottom: columnsRect.bottom,
        documentScrollY: window.scrollY,
        footerBottom: footerRect.bottom,
        footerTop: footerRect.top,
        rootScrollTop: document.documentElement.scrollTop,
        viewportHeight: window.innerHeight
      };
    });

    expect(metrics.documentScrollY).toBe(0);
    expect(metrics.rootScrollTop).toBe(0);
    expect(Math.abs(metrics.appBottom - metrics.viewportHeight)).toBeLessThanOrEqual(1);
    expect(Math.abs(metrics.footerBottom - metrics.viewportHeight)).toBeLessThanOrEqual(1);
    expect(metrics.columnsBottom).toBeLessThanOrEqual(metrics.footerTop + 1);
  } finally {
    await electronApp.close();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('real Electron app lets Copilot read the displayed record through the local tool', async () => {
  const appEnv = path.resolve('test-fixtures/e2e.env');
  const electronApp = await electron.launch({
    args: ['.'],
    env: {
      ...process.env,
      REVIEW_ASSISTANT_APP_ENV: appEnv,
      ...fakeProviderEnv,
      FAKE_COPILOT_REQUIRE_REVIEW_ASSISTANT_TOOLS: '1'
    }
  });
  const page = await electronApp.firstWindow();

  await page.getByLabel('Current project').selectOption('sample-project');
  await page.getByRole('button', { name: 'valid-record', exact: true }).click();
  await expect(page.getByText('How do I run the harness?', { exact: true }).first()).toBeVisible();

  await page.getByLabel('Message GitHub Copilot').fill('what is the persona and question?');
  await page.getByRole('button', { name: 'Send' }).click();

  await expect(page.getByText('Record persona: developer')).toBeVisible();
  await expect(page.getByText('Record question: How do I run the harness?')).toBeVisible();

  await electronApp.close();
});

test('real Electron app configures feedback and shows subsequent users collapsed history', async () => {
  test.setTimeout(60000);
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'review-assistant-feedback-'));
  const projectPath = path.join(tempRoot, 'feedback-project');
  const appEnv = path.join(tempRoot, 'app.env');
  fs.mkdirSync(projectPath);
  fs.writeFileSync(
    path.join(projectPath, '_schema.json'),
    JSON.stringify({ type: 'object', properties: { answer: { type: 'string' } }, required: ['answer'] }, null, 2)
  );
  fs.writeFileSync(path.join(projectPath, 'record-1.json'), JSON.stringify({ answer: 'Initial answer' }, null, 2));
  fs.writeFileSync(appEnv, `LOCAL_PATH=${tempRoot}\nUSERNAME=first@example.com\nAUTO_OPEN_FIRST=false\n`);

  const launch = () =>
    electron.launch({
      args: ['.'],
      env: {
        ...process.env,
        REVIEW_ASSISTANT_APP_ENV: appEnv,
        ...fakeProviderEnv
      }
    });

  const firstApp = await launch();
  const firstPage = await firstApp.firstWindow();
  await firstPage.getByLabel('Current project').selectOption('feedback-project');
  await expect(firstPage.getByLabel('Current feedback username')).toContainText('first@example.com');
  await firstPage.getByRole('button', { name: 'Configure' }).click();
  await firstPage.getByLabel('Answer feedback mode').selectOption('good_fair_bad');
  await firstPage.getByLabel('Answer comment').check();
  await firstPage.getByRole('dialog', { name: 'Feedback configuration' }).getByRole('button', { name: 'Save' }).click();
  await expect(firstPage.getByRole('dialog', { name: 'Feedback configuration' })).toBeHidden();
  await firstPage.getByRole('button', { name: 'record-1', exact: true }).click();
  await firstPage.locator('label.feedback-option').filter({ hasText: /^Good$/ }).click();
  await firstPage.getByLabel('Comment').fill('Looks good to me');
  await firstPage.getByRole('button', { name: 'Stage feedback' }).click();
  await expect(firstPage.getByText('Unsaved changes')).toBeVisible();
  await expect(firstPage.getByText('History (1)')).toBeVisible();
  await firstPage.getByRole('button', { name: 'Save' }).click();
  await expect(firstPage.getByText('All changes saved')).toBeVisible();
  await firstApp.close();

  fs.writeFileSync(appEnv, `LOCAL_PATH=${tempRoot}\nUSERNAME=second@example.com\nAUTO_OPEN_FIRST=false\n`);
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
  await secondPage.getByLabel('Answer editable').selectOption('logged');
  await secondPage.getByRole('dialog', { name: 'Feedback configuration' }).getByRole('button', { name: 'Save' }).click();
  await expect(secondPage.getByRole('dialog', { name: 'Feedback configuration' })).toBeHidden();
  await expect(secondPage.getByLabel('Edit')).toBeVisible();
  await secondPage.getByLabel('Edit').fill('Second user edit');
  await expect(secondPage.getByLabel('Edit')).toHaveValue('Second user edit');
  await secondPage.getByRole('button', { name: 'Stage feedback' }).click();
  await expect(secondPage.getByText('History (3)')).toBeVisible();
  await secondPage.getByRole('button', { name: 'Save' }).click();
  await expect(secondPage.getByText('All changes saved')).toBeVisible();

  await secondApp.close();
  fs.rmSync(tempRoot, { recursive: true, force: true });
});
