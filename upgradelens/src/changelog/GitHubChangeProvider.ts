import { EvidenceSource, PackageChange, PackageChangeProvider } from "../models/PackageChange";
import { PackageManager } from "../package/PackageManager";
import { CacheService } from "../services/CacheService";
import { compareVersions, tryParseVersion } from "../analysis/SemverUtil";
import { getJson, NetworkUnavailableError } from "../utils/httpJson";
import { getBuffer } from "../utils/httpBuffer";

interface GitHubRelease {
  tag_name: string;
  name: string | null;
  body: string | null;
  html_url: string;
  draft: boolean;
  prerelease: boolean;
}

const BREAKING_LINE_RE = /(?:^|\n)\s*[-*]?\s*(?:\*\*)?(?:BREAKING(?: CHANGE)?S?|Breaking)\b[:-]?\s*(?:\*\*)?\s*(.{5,180})/gi;
const BREAKING_HEADING_RE = /^#{1,4}\s*(?:💥\s*)?breaking changes?\s*$/im;

export function parseRepoFromUrl(repositoryUrl: string | undefined): { owner: string; repo: string } | null {
  if (!repositoryUrl) return null;
  const match = /github\.com\/([^/]+)\/([^/#?]+)/i.exec(repositoryUrl);
  if (!match) return null;
  return { owner: match[1], repo: match[2].replace(/\.git$/, "") };
}

/** Generates the handful of tag spellings real-world repos actually use for a version. */
function candidateTags(version: string, packageName: string): string[] {
  const bare = version;
  const scopedName = packageName.includes("/") ? packageName.split("/").pop()! : packageName;
  return [`v${bare}`, bare, `${packageName}@${bare}`, `${scopedName}@${bare}`, `${packageName}-v${bare}`];
}

export function extractBreakingLines(body: string): string[] {
  const lines: string[] = [];

  if (BREAKING_HEADING_RE.test(body)) {
    // Grab bullet lines under a "## Breaking Changes" heading, stopping at
    // the next heading line (so it doesn't also pick up bullets from an
    // unrelated "## Features" section further down).
    const headingStart = body.search(BREAKING_HEADING_RE);
    const afterHeading = body.slice(headingStart);
    const nextHeadingMatch = /\n#{1,4}\s+\S/.exec(afterHeading.slice(1));
    const section = nextHeadingMatch ? afterHeading.slice(0, nextHeadingMatch.index + 1) : afterHeading;
    const bulletMatches = section.matchAll(/\n\s*[-*]\s+(.{5,180})/g);
    for (const m of bulletMatches) lines.push(m[1].trim());
  }

  for (const m of body.matchAll(BREAKING_LINE_RE)) {
    lines.push(m[1].trim());
  }

  // De-dupe and cap - this is meant to surface a handful of highlights, not
  // reproduce the entire release body.
  return Array.from(new Set(lines)).slice(0, 8);
}

const VERSION_HEADING_RE = /^#{1,3}\s*\[?v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?)\]?/gm;
const CHANGELOG_FILENAMES = ["CHANGELOG.md", "CHANGES.md", "HISTORY.md"];

/** Splits a CHANGELOG.md-style document into { version, sectionText } chunks by its version headings. */
export function splitChangelogByVersion(text: string): { version: string; section: string }[] {
  const matches = Array.from(text.matchAll(VERSION_HEADING_RE));
  const sections: { version: string; section: string }[] = [];
  for (let i = 0; i < matches.length; i++) {
    const start = matches[i].index ?? 0;
    const end = i + 1 < matches.length ? matches[i + 1].index ?? text.length : text.length;
    sections.push({ version: matches[i][1], section: text.slice(start, end) });
  }
  return sections;
}

/**
 * Scans GitHub releases (unauthenticated REST API, so subject to a modest
 * rate limit) between two version tags for explicitly-flagged breaking
 * changes, falling back to the repository's CHANGELOG.md (or CHANGES.md /
 * HISTORY.md) file when releases don't yield anything - covering
 * maintainers who keep a changelog file but don't publish GitHub Releases,
 * or whose release bodies don't use a recognizable convention. This is
 * inherently best-effort: it depends on the maintainer having a
 * discoverable GitHub repository and at least one of these two mechanisms
 * with a recognizable "BREAKING CHANGE" convention. When none of that is
 * true, this provider simply returns no changes rather than failing the
 * analysis - the registry-metadata and known-changes-db providers don't
 * depend on any of this and still run.
 */
export class GitHubChangeProvider implements PackageChangeProvider {
  readonly source: EvidenceSource = "release-notes";

  constructor(private readonly packageManager: PackageManager, private readonly cache: CacheService) {}

  async getChanges(packageName: string, fromVersion: string, toVersion: string): Promise<PackageChange[]> {
    const toMeta = await this.packageManager.getVersionMetadata(packageName, toVersion);
    const repo = parseRepoFromUrl(toMeta?.repositoryUrl);
    if (!repo) return [];

    const releaseChanges = await this.getChangesFromReleases(repo, packageName, fromVersion, toVersion);
    if (releaseChanges.length > 0) return releaseChanges;

    // Nothing from tagged releases (none exist, or none matched the range,
    // or none contained a recognizable breaking-change callout) - try the
    // repository's changelog file as a second, independent source.
    return this.getChangesFromChangelogFile(repo, packageName, fromVersion, toVersion);
  }

  private async getChangesFromReleases(
    repo: { owner: string; repo: string },
    packageName: string,
    fromVersion: string,
    toVersion: string
  ): Promise<PackageChange[]> {
    const releases = await this.getReleases(repo.owner, repo.repo);
    if (releases.length === 0) return [];

    const relevant = this.selectReleasesInRange(releases, fromVersion, toVersion, packageName);
    const changes: PackageChange[] = [];

    for (const release of relevant) {
      if (!release.body) continue;
      const breakingLines = extractBreakingLines(release.body);
      for (const line of breakingLines) {
        changes.push({
          kind: "type-change",
          packageName,
          fromVersion,
          toVersion,
          summary: line,
          detail: `From the "${release.name ?? release.tag_name}" GitHub release.`,
          confidence: 0.55,
          source: this.source,
          sourceUrl: release.html_url,
        });
      }
    }

    return changes;
  }

  private async getChangesFromChangelogFile(
    repo: { owner: string; repo: string },
    packageName: string,
    fromVersion: string,
    toVersion: string
  ): Promise<PackageChange[]> {
    const from = tryParseVersion(fromVersion);
    const to = tryParseVersion(toVersion);
    if (!from || !to) return [];

    for (const filename of CHANGELOG_FILENAMES) {
      const text = await this.getRawFile(repo.owner, repo.repo, filename);
      if (!text) continue;

      const sections = splitChangelogByVersion(text);
      const relevantSections = sections.filter((s) => {
        const v = tryParseVersion(s.version);
        return v && compareVersions(v, from) > 0 && compareVersions(v, to) <= 0;
      });
      if (relevantSections.length === 0) continue;

      const changes: PackageChange[] = [];
      const fileUrl = `https://github.com/${repo.owner}/${repo.repo}/blob/HEAD/${filename}`;
      for (const section of relevantSections) {
        for (const line of extractBreakingLines(section.section)) {
          changes.push({
            kind: "type-change",
            packageName,
            fromVersion,
            toVersion,
            summary: line,
            detail: `From ${filename}, version ${section.version}.`,
            confidence: 0.5,
            source: this.source,
            sourceUrl: fileUrl,
          });
        }
      }
      if (changes.length > 0) return changes;
      // This changelog file existed and had matching version sections, but
      // none flagged a breaking change - that's a real (negative) answer,
      // not a reason to keep trying other filenames.
      return [];
    }

    return [];
  }

  private async getRawFile(owner: string, repo: string, filename: string): Promise<string | null> {
    const cacheKey = `gh-raw-file:${owner}/${repo}/${filename}`;
    const cached = this.cache.get<string | null>(cacheKey);
    if (cached !== undefined) return cached;

    try {
      const buffer = await getBuffer(`https://raw.githubusercontent.com/${owner}/${repo}/HEAD/${filename}`, {
        maxBytes: 2 * 1024 * 1024,
      });
      const text = buffer.toString("utf8");
      this.cache.set(cacheKey, text, 1000 * 60 * 60 * 6);
      return text;
    } catch {
      this.cache.set(cacheKey, null, 1000 * 60 * 60 * 6);
      return null;
    }
  }

  private selectReleasesInRange(releases: GitHubRelease[], fromVersion: string, toVersion: string, packageName: string): GitHubRelease[] {
    const toTags = new Set(candidateTags(toVersion, packageName));
    const fromTags = new Set(candidateTags(fromVersion, packageName));

    const toIndex = releases.findIndex((r) => toTags.has(r.tag_name));
    const fromIndex = releases.findIndex((r) => fromTags.has(r.tag_name));

    if (toIndex === -1) {
      // Can't anchor the target version's release - fall back to a loose tag match.
      return releases.filter((r) => r.tag_name.includes(toVersion));
    }

    // GitHub returns releases newest-first, so "between from and to" is the
    // slice from toIndex back to (but not including) fromIndex.
    const end = fromIndex === -1 ? releases.length : fromIndex;
    return releases.slice(toIndex, end).filter((r) => !r.draft && !r.prerelease);
  }

  private async getReleases(owner: string, repo: string): Promise<GitHubRelease[]> {
    const cacheKey = `gh-releases:${owner}/${repo}`;
    const cached = this.cache.get<GitHubRelease[]>(cacheKey);
    if (cached) return cached;

    try {
      const releases = await getJson<GitHubRelease[]>(`https://api.github.com/repos/${owner}/${repo}/releases?per_page=50`);
      // Releases for already-published versions don't change; cache generously
      // to stay well within GitHub's unauthenticated rate limit.
      this.cache.set(cacheKey, releases, 1000 * 60 * 60 * 6);
      return releases;
    } catch (err) {
      if (err instanceof NetworkUnavailableError) return [];
      throw err;
    }
  }
}
