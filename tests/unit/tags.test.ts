import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  discoverComputedTagPlugins,
  loadManualTagDefinitionsFromDirectories,
  reconcileComputedTags,
  tagPluginWarning
} from '../../src/main/tags';

const schema = { $id: 'qa-record', type: 'object' };
const config = {
  properties: {
    '/tags': {
      path: '/tags',
      target: 'Tags',
      tab: 'Main',
      feedback: 'none' as const,
      comments: false,
      editMode: 'inline' as const,
      presentation: 'tags' as const,
      mapping: 'tags' as const
    }
  }
};

describe('tag framework', () => {
  let tempRoot: string | undefined;

  afterEach(async () => {
    if (tempRoot) {
      await fs.rm(tempRoot, { recursive: true, force: true });
      tempRoot = undefined;
    }
  });

  it('loads manual definitions project-first and keeps first duplicate definitions', async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'review-assistant-tags-'));
    const projectTags = path.join(tempRoot, 'project', 'tags');
    const appTags = path.join(tempRoot, 'app', 'tags');
    await fs.mkdir(projectTags, { recursive: true });
    await fs.mkdir(appTags, { recursive: true });
    await fs.writeFile(
      path.join(projectTags, 'manual.json'),
      JSON.stringify([{ name: 'reviewed', description: 'Project definition' }, { name: 'escalate', description: 'Escalate' }])
    );
    await fs.writeFile(
      path.join(appTags, 'manual.json'),
      JSON.stringify([{ name: 'reviewed', description: 'App definition' }, { name: 'archive', description: 'Archive' }])
    );

    await expect(loadManualTagDefinitionsFromDirectories([projectTags, appTags])).resolves.toEqual([
      { name: 'reviewed', description: 'Project definition' },
      { name: 'escalate', description: 'Escalate' },
      { name: 'archive', description: 'Archive' }
    ]);
  });

  it('runs matching computed plugins independently, skips nonmatching schemas, deduplicates tags, and reports failures', () => {
    const data = { tags: ['manual'] };
    const result = reconcileComputedTags(schema, config, data, [], [
      {
        name: 'first',
        targetSchema: 'qa-record',
        run: (record) => {
          (record as { tags: string[] }).tags.push('computed', 'manual');
        }
      },
      {
        name: 'broken',
        targetSchema: 'qa-record',
        run: () => {
          throw new Error('boom');
        }
      },
      {
        name: 'second',
        targetSchema: 'qa-record',
        run: (record) => {
          (record as { tags: string[] }).tags.push('other');
        }
      },
      {
        name: 'wrong-schema',
        targetSchema: 'other-record',
        run: (record) => {
          (record as { tags: string[] }).tags.push('skipped');
        }
      }
    ]);

    expect(result.data).toEqual({ tags: ['manual', 'computed', 'other'] });
    expect(result.pluginErrors).toEqual(['broken: boom']);
    expect(tagPluginWarning(result.pluginErrors)).toContain('Save succeeded, but 1 tag plugin failed.');
  });

  it('validates final tag persistence constraints before save', () => {
    expect(() =>
      reconcileComputedTags(schema, config, { tags: ['x'.repeat(101)] }, [], [])
    ).toThrow('Tag exceeds 100 characters');
    expect(() =>
      reconcileComputedTags(schema, config, { tags: Array.from({ length: 101 }, (_, index) => `tag-${index}`) }, [], [])
    ).toThrow('cannot persist more than 100 tags');
    expect(() => reconcileComputedTags(schema, config, { tags: [{ name: 'object' }] }, [], [])).toThrow(
      'Tags must be stored as an array of strings'
    );
  });

  it('discovers computed plugins in deterministic folder and filename order', async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'review-assistant-tags-'));
    const projectTags = path.join(tempRoot, 'project-tags');
    const appTags = path.join(tempRoot, 'app-tags');
    await fs.mkdir(projectTags);
    await fs.mkdir(appTags);
    await fs.writeFile(path.join(projectTags, 'b.mjs'), 'export default { name: "project-b", targetSchema: "qa-record", run(record) { record.tags.push("project-b"); } };');
    await fs.writeFile(path.join(projectTags, 'a.mjs'), 'export default { name: "project-a", targetSchema: "qa-record", run(record) { record.tags.push("project-a"); } };');
    await fs.writeFile(path.join(appTags, 'a.mjs'), 'export default { name: "app-a", targetSchema: "qa-record", run(record) { record.tags.push("app-a"); } };');

    const plugins = await discoverComputedTagPlugins([projectTags, appTags]);
    const result = reconcileComputedTags(schema, config, { tags: [] }, [], plugins);

    expect(result).toMatchObject({ data: { tags: ['project-a', 'project-b', 'app-a'] }, pluginErrors: [] });
  });
});
