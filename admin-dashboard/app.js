const $ = (id) => document.getElementById(id);
const status = (message, error = false) => { $('status').textContent = message; $('status').className = error ? 'error' : ''; };
const apiUrl = () => $('apiUrl').value.replace(/\/$/, '');
const escapeHtml = (text) => String(text).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' })[char]);

async function loadReleases() {
  if (!apiUrl()) return status('Enter the API URL.', true);
  status('Loading…');
  try {
    const response = await fetch(apiUrl() + '/changelog');
    if (!response.ok) throw new Error('Request failed (' + response.status + ')');
    const releases = await response.json();
    $('releases').innerHTML = releases.map((release) => '<li><strong>v' + escapeHtml(release.version) + '</strong> — ' + escapeHtml(release.message) + '<small>' + new Date(release.publishedAt).toLocaleString() + '</small><ul>' + (release.notes || []).map((note) => '<li>' + escapeHtml(note) + '</li>').join('') + '</ul></li>').join('');
    status(releases.length + ' release(s) loaded.');
  } catch (error) { status(error.message, true); }
}

$('refresh').addEventListener('click', loadReleases);
$('releaseForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!apiUrl() || !$('adminKey').value) return status('Enter the API URL and admin key.', true);
  status('Publishing…');
  try {
    const response = await fetch(apiUrl() + '/admin/changelog', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-admin-key': $('adminKey').value },
      body: JSON.stringify({ version: $('version').value, message: $('message').value, notes: $('notes').value.split('\n').map((note) => note.trim()).filter(Boolean) }),
    });
    if (!response.ok) throw new Error((await response.json()).message || 'Request failed (' + response.status + ')');
    $('releaseForm').reset();
    await loadReleases();
    status('Changelog published. You can now send the Expo update.');
  } catch (error) { status(error.message, true); }
});
