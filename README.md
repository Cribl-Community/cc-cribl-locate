# Cribl Locate

Search every Worker Group and Edge Fleet at once to find the Sources, Destinations, and Routes that match your keywords.

This README uses fixed section names and a fixed metadata table so it can be rendered as normal Markdown today and parsed into App Gallery components later.

## Summary

Cribl Locate is a Cribl app for finding configuration across a distributed deployment. It helps users locate a Source, Destination, or Route by keyword, discover every place a value (host, token, index, pipeline, output name) is used, and jump straight to the owning group — without clicking through each group one at a time.

## What This App Does

Cribl Locate runs a keyword search across all of your Worker Groups and Edge Fleets in parallel and returns matching Sources (inputs), Destinations (outputs), and Routes.

* Primary purpose: cross-group / cross-fleet search for Stream and Edge configuration.
* Key capabilities:
  * Search Sources, Destinations, and Routes by one or more keywords at once.
  * Match on names, IDs, types, and any nested configuration value (hosts, tokens, indexes, pipelines, output names, filters, and more).
  * Scope the search to specific groups, and see which fields matched with the term highlighted.
* Intended users:
  * Admin / Platform owner / Builder
* Works with:
  * Stream / Edge / Cribl.Cloud / Hybrid / Distributed

## When To Use This App

* "Which groups still send to this Destination / use this host or token?" — audit before decommissioning.
* "Where is this Source configured?" — locate a config across dozens of groups instantly.
* "Which Routes reference this pipeline or output?" — trace routing before making a change.

## Before You Install

List anything a user or admin should know before installation.

* Required Cribl product or deployment type: [for example Cribl.Cloud, hybrid, distributed group]
* Required permissions or roles: [list roles or permissions]
* Required external systems or APIs: [if any]
* Required configuration values: [API endpoint, dataset, token source, workspace selection, and so on]
* Known limits or prerequisites: [quota, feature flag, environment requirements]

## Installation

Use Marketplace installation as the default path whenever the app is available there. This gives users the easiest install path and makes future upgrades simpler.

### Install From Marketplace or URL
1. Go to Apps in your Cribl environment.
2. Choose the Marketplace or import from URL option.
3. If the app is available in the Cribl Marketplace, install it directly from there.
4. If the app is distributed as a Marketplace-hosted URL, use the URL to import it.
5. Review the app details and complete installation.

Why this is the preferred path:
* Simplest user experience
* Easier to adopt future releases
* Cleaner upgrade path when newer versions are published

### If The App Is Not Yet In The Cribl Marketplace
1. Go to the app's GitHub repository.
2. Open the Releases section.
3. Download the `.tgz` app package for the version you want.
4. In Cribl, go to Apps and choose import from file.
5. Upload the downloaded `.tgz` file.
6. Review the app details and complete installation.

Use this path when the app has not yet been published to the Cribl Marketplace or when you need to install a specific release artifact manually.

## Configuration

Explain exactly what a user needs to fill in when the app is first created or configured.

| Setting | Required | Description | Example | Scope |
|---|---|---|---|---|
| [Setting name] | Yes/No | [What this field is for] | [Example value] | [per-user, per-app, shared] |
| [Setting name] | Yes/No | [What this field is for] | [Example value] | [per-user, per-app, shared] |
| [Setting name] | Yes/No | [What this field is for] | [Example value] | [per-user, per-app, shared] |

Add guidance such as:
* Which fields are mandatory
* Which fields are optional
* Safe defaults
* What happens if a field is left blank
* Whether settings are per-user, per-app, or shared

## How To Use

Describe the happy path for a new user.

### Typical Workflow
1. Open the app from the Apps page.
2. Review or update the app settings.
3. Provide the required inputs.
4. Run the main workflow or action.
5. Review the output, results, or generated state.

### First-Run Checklist
* [Step 1]
* [Step 2]
* [Step 3]

## Permissions

Document the permissions the app expects and how it behaves if a user lacks them.

Include:
* Required permissions for core functionality
* Optional permissions for enhanced features
* Any APIs or resources the app reads or writes
* What users should expect if access is denied

### Cribl API Endpoints Used

List every Cribl API endpoint the app uses. Add one row per endpoint.

| Method | Endpoint | Purpose |
|---|---|---|
| GET | `/master/groups` | List all Worker Groups and Edge Fleets to determine the search scope. |
| GET | `/m/:gid/system/inputs` | Read the Sources (inputs) in a group. |
| GET | `/m/:gid/system/outputs` | Read the Destinations (outputs) in a group. |
| GET | `/m/:gid/routes` | Read the routing tables (Routes) in a group. |

Cribl Locate is strictly read-only — it issues only `GET` requests and never creates, modifies, or deletes configuration.

Suggested text:
This app should handle permission differences gracefully where possible. If a user lacks access to an optional API or resource, the app should continue to function for supported workflows and show a helpful message instead of failing completely.

## External API Access

If applicable, describe any bundled defaults or external access patterns.

### Default Configuration
* `default/proxies.yml` — [what it contains]
* `default/policies.yml` — [what it contains]
* Any other shipped config — [description]

### External Endpoints
* [Service name] — [purpose]
* [Service name] — [purpose]

If the app makes no external calls, say so clearly.

## Data And Storage

Explain what the app stores or changes.

Example topics:
* KV keys used by the app
* Whether data is persisted
* Whether data is shared across users
* Cleanup behavior on uninstall, if known
* Any quotas or limits that affect usage

## Support

Choose one support model and remove the others.

Also tell users exactly how to reach the developer or maintainer for this app. Include a clear support path such as an email address, Slack channel, GitHub issues page, support alias, or team name.

### Cribl Built
This app is built by Cribl and supported by Cribl. Issues, bugs, and questions should follow standard Cribl support channels. Also include the owning team and the best contact path for the app maintainer.

### Partner Built
This app is built by [Partner Name]. The partner owns support, maintenance, and feature requests for this app. Cribl does not provide direct support for app-specific behavior unless explicitly stated. Also include the partner support contact and the best developer or maintainer contact path.

### Community Built
This app is provided as a community contribution. It may be useful for learning, experimentation, or shared workflows, but it does not carry an official support commitment from Cribl. Maintenance and updates depend on the community maintainer. Also include how users can reach the maintainer or contributor.

### Internal Only
This app is intended for internal use, experiments, demos, or proof-of-concept workflows. It should not be treated as a generally supported production app unless its support model changes. Also include the internal owner and how to contact the developer or team responsible for the app.

## Known Limitations

Use this section to set expectations.

* [Limitation 1]
* [Limitation 2]
* [Limitation 3]

## Troubleshooting

### The App Opens But Some Features Do Not Work
Possible causes:
* Missing permissions
* Missing required settings
* External dependency unavailable
* Unsupported environment

### The App Cannot Connect To An API Or Service
Check:
* App settings
* Network or proxy configuration
* Credentials or tokens
* Allowed endpoints

### The App Works Locally But Not In Cribl
Check:
* Packaging and deployment version
* Runtime configuration
* Required platform globals or APIs
* Environment-specific permissions

## Development

If this repository is also intended for builders, include a short developer section.

```bash
npm install
npm run dev
npm run package
```

Document:
* How to run locally
* Any important environment differences
* How to package and test the app
* Where the main source files live

## Project Layout

```text
src/
  App.tsx
  [other files]
config/
  [config files]
default/
  [packaged default config files]
store/
  README.md
LICENSE
README.md
```

## Versioning And Releases

Explain how versions are managed and how users should consume releases.

* Follow semantic versioning
* Use tagged releases for reproducible installs
* Document upgrade notes when configuration or behavior changes

## Contributing

If contributions are allowed, add:
* How to open issues
* How to propose changes
* Review expectations
* Any coding or content standards

## License

This app is licensed under the terms in [LICENSE](./LICENSE).

If needed, add one sentence clarifying any third-party dependencies or additional notices.

## App Metadata

Use this table as the canonical source for gallery fields. Keep the left column labels exactly as written.

| Field | Value |
|---|---|
| App Name | [App Title] |
| App ID | [app-id] |
| Version | [x.y.z] |
| Author | [Cribl, Partner Name, Community, or Internal Team] |
| Support Model | [cribl-built, partner-built, community-built, internal-only] |
| Support Label | [Cribl Built, Partner Built, Community Built, Internal Only] |
| Support Contact | [support channel, email, or URL] |
| License | [SPDX identifier or "See LICENSE"] |
| License File | [Apache License 2.0](https://www.apache.org/licenses/LICENSE-2.0.txt) |
| Product Tags | [stream, edge, search, lake, insights] |
| Category | [primary category] |
| Audience | [admin, analyst, platform-owner, builder, end-user] |
| Availability | [preview, ga, internal, deprecated] |
| Requires External Access | [yes or no] |
| Repository | [repository URL if applicable] |
| Documentation | [docs URL if applicable] |
| README Schema Version | [1.0] |
