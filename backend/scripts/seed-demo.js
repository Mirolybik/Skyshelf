#!/usr/bin/env node
/* Заполнение базы демонстрационными данными для тестового стенда (npm run seed). */
'use strict';

const { Database } = require('../src/db/database');
const { MigrationRunner } = require('../src/db/migrate');
const { CryptoService } = require('../src/services/crypto-service');
const { Repositories } = require('../src/repositories');
const { Account, Project, Membership, ProjectTask } = require('../src/domain/entities');

const DEMO_PASSWORD = 'SkyShelfDemo2026!';

const ACCOUNTS = [
  { email: 'demo@skyshelf.local', name: 'Демо Пользователь', role: 'ADMIN', plan: 'TEAM' },
  { email: 'anna@skyshelf.local', name: 'Анна Смирнова', role: 'USER', plan: 'PERSONAL' },
  { email: 'ilya@skyshelf.local', name: 'Илья Ковалёв', role: 'USER', plan: 'START' },
];

async function main() {
  const dbUrl = process.env.DATABASE_URL ||
    `postgres://${process.env.DB_USER || 'skyshelf'}:${process.env.DB_PASSWORD || 'skyshelf'}@${process.env.DB_HOST || 'localhost'}:${process.env.DB_PORT || 5432}/${process.env.DB_NAME || 'skyshelf'}`;
  const db = new Database(dbUrl);
  const runner = new MigrationRunner(db.pool);
  await runner.up();

  const repos = new Repositories(db);
  const crypto = new CryptoService(process.env.SKYSHELF_MASTER_KEY || 'U2t5U2hlbGYtRGVtby1NYXN0ZXItS2V5LTIwMjYhISE=');

  const created = [];
  const accounts = [];
  for (const spec of ACCOUNTS) {
    let account = await repos.accounts.findByEmail(spec.email);
    if (!account) {
      account = await repos.accounts.insert(new Account({
        email: spec.email,
        name: spec.name,
        role: spec.role,
        plan: spec.plan,
        passwordHash: await crypto.hashPassword(DEMO_PASSWORD),
      }));
      created.push(`account ${spec.email} (${spec.role})`);
    } else if (spec.role === 'ADMIN' && account.role !== 'ADMIN') {
      await repos.accounts.update(account.id, { role: 'ADMIN', plan: spec.plan });
    }
    accounts.push(account);
  }

  const [owner, member, reader] = accounts;
  let project = await repos.projects.findWhere('owner_id = $1 AND name = $2', [owner.id, 'Веб-сервис «SkyShelf»']);
  project = project[0] ?? null;
  if (!project) {
    project = await repos.projects.insert(new Project({
      ownerId: owner.id,
      name: 'Веб-сервис «SkyShelf»',
      description: 'Учебный проект: защищённое облако для команд. Демонстрационные данные тестового стенда.',
      course: 'Веб-разработка, модуль 4',
      teacher: 'Петрова И. Н.',
      accent: 'violet',
      cover: 'orb',
      status: 'IN_PROGRESS',
      plan: 'TEAM',
    }));
    created.push('project');
    await repos.memberships.insert(new Membership({ projectId: project.id, userId: owner.id, role: 'OWNER' }));
    await repos.memberships.insert(new Membership({ projectId: project.id, userId: member.id, role: 'MEMBER' }));
    await repos.memberships.insert(new Membership({ projectId: project.id, userId: reader.id, role: 'READER' }));
    created.push('memberships OWNER/MEMBER/READER');

    const checklist = [
      ['Спроектировать схему данных', true],
      ['Реализовать аутентификацию и сессии', true],
      ['Шифрование файлов при хранении', true],
      ['Публичные ссылки на файлы', false],
      ['Экспорт проекта в ZIP', false],
    ];
    let position = 0;
    for (const [title, completed] of checklist) {
      await repos.tasks.insert(new ProjectTask({ projectId: project.id, title, completed, position: position++ }));
    }
    created.push('checklist tasks');
  } else {
    const ownerMember = await repos.memberships.find(project.id, owner.id);
    if (!ownerMember) {
      await repos.memberships.insert(new Membership({ projectId: project.id, userId: owner.id, role: 'OWNER' }));
    }
  }

  console.log(created.length ? `seed: добавлено — ${created.join(', ')}` : 'seed: демо-данные уже в базе');
  console.log(`Вход: ${ACCOUNTS.map((a) => a.email).join(', ')} / пароль: ${DEMO_PASSWORD}`);
  await db.close();
}

main().catch((error) => { console.error(error); process.exit(1); });
