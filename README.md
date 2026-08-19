# Cribl Locate

Search every Stream Worker Group and Edge Fleet at once to find the Sources, Destinations, Routes, and Pipelines that match your keywords.

## Summary

Cribl Locate is a read-only Cribl app for finding configuration across a distributed deployment. Instead of clicking through each Worker Group and Fleet one at a time, you enter one or more keywords and Cribl Locate searches them all in parallel — then shows you exactly where each match lives and which fields matched.

Use it to answer questions like:

- **"Where is this Source configured?"** — locate a config across dozens of groups instantly.
- **"Which groups still send to this Destination, host, or token?"** — audit before decommissioning.
- **"Which Routes or Pipelines reference this output?"** — trace routing before making a change.

## Features

- **Cross-group search** — queries every Stream Worker Group and Edge Fleet at once (Search groups and Outpost groups are excluded).
- **Four resource types** — Sources (Collectors included), Destinations, Routes, and Pipelines.
- **Deep matching** — matches on names, IDs, and types, and scans any nested configuration value (hosts, tokens, indexes, pipeline names, output names, filters, and more), with the matched field and term highlighted.
- **Match any / match all** — find results containing *any* keyword, or require *all* keywords.
- **Scope control** — search everything, or narrow to specific Stream Worker Groups vs. Edge Fleets.
- **Enabled/disabled filter** — show or hide disabled configurations in the results.
- **Collapsible results** — collapse or expand each resource type (Sources, Destinations, Routes, Pipelines) independently.
- **CSV export** — download the current results for auditing or sharing.
- **Strictly read-only** — issues only `GET` requests; never creates, modifies, or deletes configuration.

## Before You Install

- **Deployment**: Cribl.Cloud, hybrid, or distributed (a Leader managing one or more Worker Groups / Edge Fleets).
- **Role**: a role that can view Worker Group / Fleet configuration (Workspace Administrator, or equivalent read access).
- **External systems**: none — the app talks only to the Cribl REST API through the platform proxy.
- **Configuration values**: none — there is nothing to configure after install.

## Installation

Install directly from this repository using Cribl's **Import from Git**.

1. Log in to Cribl and click **Apps → View All**.
2. Click **Add App → Import from Git**.
3. Paste the repository URL and enter `latest` for the release tag:

   ```
   https://github.com/Cribl-Community/cc-cribl-locate.git
   ```

4. Click **Import**.

> The `latest` tag is a rolling reference to the most recent published release, kept up to date automatically by the repository's release workflow.

### Alternative: Import from file

1. Download the `.tgz` package from the repository's **Releases**.
2. In Cribl, go to **Apps → Add App → Import from file**.
3. Upload the `.tgz` and complete installation.

## How To Use

1. Open **Cribl Locate** from the Apps page.
2. Enter one or more keywords (separate with spaces, commas, or new lines).
3. Choose which resource types to include (Sources, Destinations, Routes, Pipelines).
4. Pick **Match any keyword** or **Match all keywords**.
5. (Optional) Narrow the scope to specific Worker Groups or Fleets, and toggle enabled/disabled results.
6. Click **Search**. Expand or collapse each result section, open the owning group, or **Export CSV**.

## Permissions

Cribl Locate reads configuration from the Cribl REST API through the platform proxy (which injects auth automatically). It is read-only and gracefully skips any group it cannot read, showing a per-group error instead of failing the whole search.

### Cribl API Endpoints Used

| Method | Endpoint | Purpose |
|---|---|---|
| GET | `/master/groups` | List all Worker Groups and Edge Fleets to determine the search scope. |
| GET | `/m/:gid/system/inputs` | Read the Sources (inputs) in a group. |
| GET | `/m/:gid/system/outputs` | Read the Destinations (outputs) in a group. |
| GET | `/m/:gid/routes` | Read the routing tables (Routes) in a group. |
| GET | `/m/:gid/pipelines` | Read the Pipelines in a group. |
| GET | `/m/:gid/collectors` | Read the Collectors in a group (surfaced under Sources). |

These paths are declared in `default/policies.yml` and granted at install time.

## Development

```bash
npm install
npm run dev       # local dev server (use Cribl Live Preview to reach the API)
npm run lint
npm run package   # build a .tgz app package under build/
```

Running the dev server directly in a browser will show a "must run inside Cribl" message, because the Cribl API globals are only injected when the app runs inside the platform (via Live Preview or after install).

Main source files:

```text
src/
  App.tsx     UI: search controls, scope selection, results
  api.ts      read-only Cribl REST API client
  search.ts   term parsing, matching, and CSV export
config/
  policies.yml   Cribl API paths granted at install
  proxies.yml    external domains (none required)
```

## Support

Community-built. This app is provided as a community contribution without an official Cribl support commitment. For issues or questions, open a GitHub issue on this repository or contact the maintainer.

## App Metadata

| Field | Value |
|---|---|
| App Name | Cribl Locate |
| App ID | cribl_locate |
| Version | 1.0.0 |
| Author | Chris Winarski — cwinarski@cribl.io |
| Support Model | community-built |
| Support Label | Community Built |
| Support Contact | cwinarski@cribl.io |
| License | Apache-2.0 |
| License File | [Apache License 2.0](https://www.apache.org/licenses/LICENSE-2.0.txt) |
| Product Tags | stream, edge |
| Audience | admin, platform-owner, builder |
| Requires External Access | no |
| Repository | https://github.com/Cribl-Community/cc-cribl-locate |
| README Schema Version | 1.0 |
