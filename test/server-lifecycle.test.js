const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const serverSource = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

test('extension lifecycle accepts progress stages and terminal routes advance the queue', () => {
  assert.match(serverSource, /app\.post\('\/api\/extension\/task-progress'/);
  assert.match(serverSource, /Submitting/);
  assert.match(serverSource, /Rendering/);
  assert.match(serverSource, /Downloading/);

  const completeRoute = serverSource.match(/app\.post\('\/api\/extension\/complete-task'[\s\S]*?\n\}\);/);
  const failRoute = serverSource.match(/app\.post\('\/api\/extension\/fail-task'[\s\S]*?\n\}\);/);
  assert.ok(completeRoute, 'complete-task route must exist');
  assert.ok(failRoute, 'fail-task route must exist');
  assert.match(completeRoute[0], /isProcessing\s*=\s*false/);
  assert.match(completeRoute[0], /setTimeout\(processNextQueue,\s*500\)/);
  assert.match(failRoute[0], /isProcessing\s*=\s*false/);
  assert.match(failRoute[0], /setTimeout\(processNextQueue,\s*500\)/);
});

test('server does not download Google media or complete tasks outside Chrome download confirmation', () => {
  assert.doesNotMatch(serverSource, /\/api\/extension\/download-video/);
  assert.doesNotMatch(serverSource, /pendingTask\.status\s*=\s*['"]Completed['"]/);
  assert.doesNotMatch(serverSource, /\.saveAs\(/);
});
