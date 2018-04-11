#!/usr/bin/env node

import Octokat from 'octokat';
import inquirer from 'inquirer';
import 'colors';
import open from 'open';
import { pick } from 'lodash';
import { fromRepoConfig, toRepoConfig, userTokens } from './config.js';

const fromGithub = new Octokat({
  token: fromRepoConfig.token,
  rootURL: fromRepoConfig.rootURL
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

async function migrateComment(issue, comment) {
  const {repo, body} = getBodyAndRepo(comment);
  await repo.issues(issue.number).comments.create({body});
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
    return {body, repo, keepUser: true};
  }

  body = [
    body,
    '',
    `*Originally posted by @${migratingFrom.user.login} at ${new Date(migratingFrom.createdAt).toUTCString()} at ${migratingFrom.htmlUrl}*`,
  ].join('\n');
  return {body, repo: toRepo, keepUser: false};
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
    const comments = await fromRepo.issues(issue.number).comments.fetch();
    for (const comment of comments) {
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
  }
}

async function main() {
  await migrateIssues();
  console.log('\n👋  Ok! Goodbye!'.bold);
}

function clearConsole() {
  process.stdout.write('\x1Bc');
}

try {
  // clearConsole();
  console.log('🖖  Greetings, hooman!\n')
  console.log(`🚚  Ready to migrate issues from ${fromRepoName.bold} to ${toRepoName.bold}?\n`);
  main();
} catch (e) {
  console.log(e);
}
