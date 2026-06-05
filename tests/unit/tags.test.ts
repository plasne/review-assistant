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
    const projectTags = path.join(tempRoot, 'project', 'config');
    const appTags = path.join(tempRoot, 'app', 'config');
    await fs.mkdir(projectTags, { recursive: true });
    await fs.mkdir(appTags, { recursive: true });
    await fs.writeFile(
      path.join(projectTags, 'tags.json'),
      JSON.stringify([{ name: 'reviewed', description: 'Project definition' }, { name: 'escalate', description: 'Escalate' }])
    );
    await fs.writeFile(
      path.join(appTags, 'tags.json'),
      JSON.stringify([{ name: 'reviewed', description: 'App definition' }, { name: 'archive', description: 'Archive' }])
    );

    await expect(loadManualTagDefinitionsFromDirectories([projectTags, appTags])).resolves.toEqual([
      { name: 'reviewed', description: 'Project definition' },
      { name: 'escalate', description: 'Escalate' },
      { name: 'archive', description: 'Archive' }
    ]);
  });

  it('runs all computed plugins independently, deduplicates tags, and reports failures', () => {
    const data = { tags: ['manual'] };
    const result = reconcileComputedTags(schema, config, data, [], [
      {
        name: 'first',
        tag: (record) => {
          (record as { tags: string[] }).tags.push('computed', 'manual');
        }
      },
      {
        name: 'broken',
        tag: () => {
          throw new Error('boom');
        }
      },
      {
        name: 'second',
        tag: (record) => {
          (record as { tags: string[] }).tags.push('other');
        }
      },
      {
        name: 'schema-agnostic',
        tag: (record) => {
          (record as { tags: string[] }).tags.push('schema-agnostic');
        }
      }
    ]);

    expect(result.data).toEqual({ tags: ['manual', 'computed', 'other', 'schema-agnostic'] });
    expect(result.pluginErrors).toEqual(['broken: boom']);
    expect(tagPluginWarning(result.pluginErrors)).toContain('Save succeeded, but 1 tag plugin failed.');
  });

  it('passes schema, tags path, and manual definitions to computed plugins', () => {
    const data = { metadata: { tags: [] } };
    const manualTagDefinitions = [{ name: 'needs-review', description: 'Needs review' }];
    const configWithNestedTags = {
      properties: {
        '/metadata/tags': {
          ...config.properties['/tags'],
          path: '/metadata/tags'
        }
      }
    };

    const result = reconcileComputedTags(schema, configWithNestedTags, data, manualTagDefinitions, [
      {
        name: 'context-aware',
        tag: (record, context) => {
          expect(context).toEqual({ schema, tagsPath: '/metadata/tags', manualTagDefinitions });
          (record as { metadata: { tags: string[] } }).metadata.tags.push(context.manualTagDefinitions[0].name);
        }
      }
    ]);

    expect(result).toMatchObject({ data: { metadata: { tags: ['needs-review'] } }, pluginErrors: [] });
  });

  it('does not run computed plugins when no schema path is mapped to tags', () => {
    const data = { tags: ['manual'] };
    const result = reconcileComputedTags(schema, { properties: {} }, data, [], [
      {
        name: 'should-not-run',
        tag: (record) => {
          (record as { tags: string[] }).tags.push('computed');
        }
      }
    ]);

    expect(result).toEqual({ data: { tags: ['manual'] }, pluginErrors: [] });
  });

  it('rejects async computed plugins without swallowing the error', () => {
    const result = reconcileComputedTags(schema, config, { tags: [] }, [], [
      {
        name: 'async-plugin',
        tag: async () => undefined
      }
    ]);

    expect(result).toMatchObject({ data: { tags: [] }, pluginErrors: ['async-plugin: Tag plugins must run synchronously.'] });
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
    await fs.writeFile(path.join(projectTags, 'b.mjs'), 'export default { name: "project-b", tag(record) { record.tags.push("project-b"); } };');
    await fs.writeFile(path.join(projectTags, 'a.mjs'), 'export default { name: "project-a", tag(record) { record.tags.push("project-a"); } };');
    await fs.writeFile(path.join(projectTags, 'helper.js'), 'export default { name: "helper", tag(record) { record.tags.push("skipped"); } };');
    await fs.writeFile(path.join(appTags, 'a.mjs'), 'export default { name: "app-a", tag(record) { record.tags.push("app-a"); } };');

    const plugins = await discoverComputedTagPlugins([projectTags, appTags]);
    const result = reconcileComputedTags(schema, config, { tags: [] }, [], plugins);

    expect(result).toMatchObject({ data: { tags: ['project-a', 'project-b', 'app-a'] }, pluginErrors: [] });
  });

  it('reports malformed computed plugin modules instead of silently skipping them', async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'review-assistant-tags-'));
    const appConfig = path.join(tempRoot, 'config');
    await fs.mkdir(appConfig, { recursive: true });
    await fs.writeFile(path.join(appConfig, 'broken.mjs'), 'export default { name: "broken", transform(record) { record.tags.push("skipped"); } };');

    const plugins = await discoverComputedTagPlugins([appConfig]);
    const result = reconcileComputedTags(schema, config, { tags: [] }, [], plugins);

    expect(result).toMatchObject({
      data: { tags: [] },
      pluginErrors: ['Tag plugin broken.mjs must export a tag(record, context) function.']
    });
  });

  it('ignores reserved config JSON files when discovering computed plugins', async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'review-assistant-tags-'));
    const projectConfig = path.join(tempRoot, 'project', 'config');
    await fs.mkdir(projectConfig, { recursive: true });
    await fs.writeFile(path.join(projectConfig, 'config.json'), 'export default { tag(record) { record.tags.push("bad-config"); } };');
    await fs.writeFile(path.join(projectConfig, 'schema.json'), 'export default { tag(record) { record.tags.push("bad-schema"); } };');
    await fs.writeFile(path.join(projectConfig, 'tags.json'), JSON.stringify([{ name: 'manual', description: 'Manual' }]));
    await fs.writeFile(path.join(projectConfig, 'helper.cjs'), 'module.exports = { tag(record) { record.tags.push("bad-helper"); } };');
    await fs.writeFile(path.join(projectConfig, 'computed.mjs'), 'export default { name: "computed", tag(record) { record.tags.push("computed"); } };');

    const plugins = await discoverComputedTagPlugins([projectConfig]);
    const result = reconcileComputedTags(schema, config, { tags: [] }, [], plugins);

    expect(result).toMatchObject({ data: { tags: ['computed'] }, pluginErrors: [] });
  });

  it('supports turns cardinality tags from a config plugin', async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'review-assistant-tags-'));
    const projectTags = path.join(tempRoot, 'agent01', 'config');
    await fs.mkdir(projectTags, { recursive: true });
    await fs.writeFile(
      path.join(projectTags, 'turns.mjs'),
      `const TURN_TAGS = ['turns:multi', 'turns:single'];
export default {
  name: 'turns',
  tag(record) {
    const turnsTag = Array.isArray(record.turns) && record.turns.length > 0 ? (record.turns.length > 1 ? 'turns:multi' : 'turns:single') : undefined;
    const tags = Array.isArray(record.tags) ? record.tags.filter((tag) => !TURN_TAGS.includes(tag)) : [];
    record.tags = turnsTag ? [...tags, turnsTag] : tags;
  }
};`
    );

    const plugins = await discoverComputedTagPlugins([projectTags]);
    const single = reconcileComputedTags({}, config, { turns: [{}], tags: ['manual', 'turns:multi', 'turns:single'] }, [], plugins);
    const multi = reconcileComputedTags({}, config, { turns: [{}, {}], tags: ['manual', 'turns:single', 'turns:multi'] }, [], plugins);

    expect(single).toMatchObject({ data: { turns: [{}], tags: ['manual', 'turns:single'] }, pluginErrors: [] });
    expect(multi).toMatchObject({ data: { turns: [{}, {}], tags: ['manual', 'turns:multi'] }, pluginErrors: [] });
  });
});
