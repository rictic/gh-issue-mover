#!/usr/bin/env node

import Octokat from 'octokat';
import inquirer from 'inquirer';
import 'colors';
import open from 'open';
import { pick } from 'lodash';
import { fromRepoConfig, toRepoConfig, userTokens } from './config.js';

const fromGithub = new Octokat({
  token: fromRepoConfig.token,
  rootURL: fromRepoConfig.rootURL,
});

const toGithub = new Octokat({
  token: toRepoConfig.token,
  rootURL: toRepoConfig.rootURL
});

const userGithubs = new Map(
  (userTokens || []).map(({username, token}) => [username, new Octokat({token})]));

const fromRepoName = `${fromRepoConfig.owner}/${fromRepoConfig.name}`;
const toRepoName = `${toRepoConfig.owner}/${toRepoConfig.name}`;

const fromRepo = fromGithub.repos(fromRepoConfig.owner, fromRepoConfig.name);
const toRepo = fromGithub.repos(toRepoConfig.owner, toRepoConfig.name);

const rateLimitCooldownSeconds = 65;
function isRateLimitError(err) {
  const limitUrl = "https://developer.github.com/v3/#abuse-rate-limits";
  return err &&
      err.status === 403 &&
      err.json &&
      err.json.documentation_url === limitUrl;
}

async function migrateComment(issue, comment) {
  const {repo, github, body} = getBodyAndRepo(comment);
  const {remaining} = await rateLimit(github);
  try {
    await repo.issues(issue.number).comments.create({body});
  } catch (err) {
    if (isRateLimitError(err)) {
      await new Promise(
          (resolve) => setTimeout(resolve, rateLimitCooldownSeconds * 1000));
      await migrateComment(issue, comment);
      return;
    }
    throw err;
  }
}

function fixupRepoLinks(markdownText) {
  return markdownText.replace(
      /(^|\s)#(\d+)(\s|$)/,
      `$1https://github.com/${fromRepoName}/issues/$2$3`);
}

function getBodyAndRepo(migratingFrom) {
  let body = migratingFrom.body;
  body = fixupRepoLinks(body);

  const userGithub = userGithubs.get(migratingFrom.user.login);
  if (userGithub) {
    body = [
      body,
      '',
      `*Originally posted at ${new Date(migratingFrom.createdAt).toUTCString()} at ${migratingFrom.htmlUrl}*`,
    ].join('\n');
    const repo = userGithub.repos(toRepoConfig.owner, toRepoConfig.name);
    return {body, repo, keepUser: true, github: userGithub};
  }

  body = [
    body,
    '',
    `*Originally posted by @${migratingFrom.user.login} at ${new Date(migratingFrom.createdAt).toUTCString()} at ${migratingFrom.htmlUrl}*`,
  ].join('\n');
  return {body, repo: toRepo, keepUser: false, github: toGithub};
}

async function* getAllFromCollection(collection, options={}) {
  let page = 1;
  while (true) {
    const batch = await collection.fetch({...options, page});
    if (batch.length === 0) {
      break;
    }
    for (const member of batch) {
      yield member;
    }
    page++;
  }
}

async function migrateIssue(issue) {
  const {body, repo} = getBodyAndRepo(issue);
  const issueToCreate = {
    ...pick(issue, ['title', 'labels']),
    assignees: issue.assignees.map(a => a.login),
    body
  };
  issueToCreate.title = `[${fromRepoConfig.name}] ${issueToCreate.title}`;
  try {
    const newIssue = await repo.issues.create(issueToCreate);
    const comments = getAllFromCollection(fromRepo.issues(issue.number).comments);
    for await (const comment of comments) {
      await migrateComment(newIssue, comment);
    }
    await fromRepo.issues(issue.number).comments.create({
      body: `Issue migrated to ${toRepoConfig.owner}/${toRepoConfig.name}#${newIssue.number}`
    });
    await fromRepo.issues(issue.number).update({ state: 'closed' });
    if (issue.state === 'closed') {
      const result = await toRepo.issues(newIssue.number).update(
          { state: 'closed'});
    }
    console.log(
      '\n',
      '🍭  Successfully migrated issue',
      'from',
      `${fromRepoConfig.owner}/${fromRepoConfig.name}#${issue.number}`.bold,
      'to',
      `${toRepoConfig.owner}/${toRepoConfig.name}#${newIssue.number}`.bold,
      '\n'
    );
    return newIssue;
  } catch (e) {
    console.log(`😱 Something went wrong while migrating issue #${issue.number}!`);
    console.log(JSON.stringify(e, null, 2));
  }
}

async function migrateAllIssues() {
  const issuesIterator = getAllFromCollection(fromRepo.issues, {state: 'all'});
  const issues = (await flattenAsyncIterator(issuesIterator)).filter(
      (i) => !i.pullRequest);

  console.log(`found ${issues.length} issues`);
  issues.sort((a, b) => a.number - b.number);
  for (const issue of issues) {
    console.log(`[${issue.number}] ${issue.title}`);
  }

  const { confirm } = await inquirer.prompt([{
    type: 'confirm',
    name: 'confirm',
    default: false,
    message: [
      `You're about to migrate`,
      `${issues.length} issues.`.green,
      'Are you sure?'
    ].join(' ')
  }]);
  if (!confirm) {
    return;
  }
  for (const issue of issues) {
    const newIssue = await migrateIssue(issue);
    if (!newIssue) {
      console.log(`Failed to migrate issue #${issue.number}!`);
      return;
    }
  }

  console.log(`All issues migrated successfully!`);
}

async function flattenAsyncIterator(iter) {
  const results = [];
  for await (const val of iter) {
    results.push(val);
  }
  return results;
}

async function migrateIssuesByLabel(labels) {
  const issuesAndPRs = await fromRepo.issues.fetch({ labels, state: 'open', filter: 'all' });
  const issues = issuesAndPRs.filter(i => !i.pullRequest);

  if (issues.length === 0) {
    console.log(`Sorry, no issues found matching labels ${labels.split(', ').map(l => l.green)}`);
    const { retry } = await inquirer.prompt([{
      type: 'confirm',
      name: 'retry',
      message: 'Do you want to try again?'
    }]);
    if (retry) {
      await migrateIssues();
    }
  } else {
    const { confirm } = await inquirer.prompt([{
      type: 'confirm',
      name: 'confirm',
      default: false,
      message: [
        `You're about to migrate`,
        `${issues.length} issues`.green,
        'matching the labels',
        labels.split(', ').map(l => l.green),
        '. Are you sure?'
      ].join(' ')
    }]);
    if (confirm) {
      await Promise.all(issues.forEach(migrateIssue));
      console.log(
        '\n',
        `🌟  Successfully migrated ${issues.length} issues`,
        'from',
        `${fromRepoConfig.owner}/${fromRepoConfig.name}`.bold,
        'to',
        `${toRepoConfig.owner}/${toRepoConfig.name}`.bold
      );
    }
  }
}

async function migrateIssuesOneByOne() {
  const { issueNumber } = await inquirer.prompt([{
    type: 'input',
    name: 'issueNumber',
    message: 'Which issue do you want to migrate? (type the #)'
  }]);
  const issue = await fromRepo.issues(issueNumber).fetch();
  console.log();
  console.log('🚀  Successfully retrieved issue', `#${issue.number}`.bold);
  console.log();
  console.log('Title:', issue.title.bold);
  console.log('Author:', issue.user.login.bold);
  console.log('State:', issue.state === 'open' ? issue.state.green.bold : issue.state.red.bold);
  console.log();
  const { confirm } = await inquirer.prompt([{
    type: 'confirm',
    name: 'confirm',
    default: false,
    message: [
      `You're about to migrate issue #${String(issue.number).yellow.bold} from`,
      `${fromRepoConfig.owner}/${fromRepoConfig.name}`.bold,
      'to',
      `${toRepoConfig.owner}/${toRepoConfig.name}`.bold,
      '. Are you sure?'
    ].join(' ')
  }]);

  if (confirm) {

    const newIssue = await migrateIssue(issue);

    const { openInBrowser } = await inquirer.prompt([{
      type: 'confirm',
      name: 'openInBrowser',
      message: 'Open new issue in browser now?'
    }]);

    if (openInBrowser) {
      open(newIssue.htmlUrl);
    }

  }

  const prefix = confirm ? 'That was fun! 💃 ' : 'Oh, I see 👀 ';

  const { anotherOne } = await inquirer.prompt([{
    type: 'confirm',
    name: 'anotherOne',
    message: `${prefix} Do you want to migrate another issue?`
  }]);

  if (anotherOne) {
    await migrateIssuesOneByOne();
  }

}

async function chooseMigrationType() {
  const { migrationType } = await inquirer.prompt([{
    type: 'list',
    name: 'migrationType',
    message: 'How do you want to migrate the issues?',
    choices: [{
      name: 'one by one',
      value: 'oneByOne'
    }, {
      name: 'by label',
      value: 'byLabel'
    }, {
      name: 'all (including closed)',
      value: 'all'
    }]
  }]);

  const { labels } = await inquirer.prompt([{
    type: 'input',
    name: 'labels',
    message: 'Cool, which labels? (separate multiple labels with commas. They will go in AND)',
    when: migrationType === 'byLabel'
  }]);

  return { migrationType, labels };
}

async function migrateIssues() {
  const { migrationType, labels } = await chooseMigrationType();

  switch (migrationType) {
    case 'byLabel': await migrateIssuesByLabel(labels); break;
    case 'oneByOne': await migrateIssuesOneByOne(); break;
    case 'all': await migrateAllIssues(); break;
  }
}

async function main() {
  console.log('🖖  Greetings, hooman!\n')
  console.log(`🚚  Ready to migrate issues from ${fromRepoName.bold} to ${toRepoName.bold}?\n`);
  await migrateIssues();
  console.log('\n👋  Ok! Goodbye!'.bold);
}

function clearConsole() {
  process.stdout.write('\x1Bc');
}

async function rateLimit(gitHub) {
  const response = await gitHub.fromUrl('/rate_limit').fetch();
  return response.resources.core; // {limit, remaining, reset}
}


main().catch((e) => {
  e = e || 'Empty error';
  console.error(e.stack || e);
  process.exitCode = 1;
});
