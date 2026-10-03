import { randomUUID } from 'node:crypto';

export interface ThreadsIntegrationPost {
  id: string;
  ownerId?: string;
  text?: string;
  isReply?: boolean;
  isReplyOwnedByMe?: boolean;
  rootPostId?: string;
  repliedToId?: string;
}

export interface ThreadsIntegrationProvider {
  ownPosts(accountId: string, limit?: number): Promise<ThreadsIntegrationPost[]>;
  getPost(accountId: string, postId: string): Promise<ThreadsIntegrationPost>;
  publish(accountId: string, input: { text: string }): Promise<{ remoteId: string }>;
  replies(accountId: string, parentId: string): Promise<ThreadsIntegrationPost[]>;
  conversation(accountId: string, parentId: string): Promise<ThreadsIntegrationPost[]>;
  reply(accountId: string, targetId: string, text: string): Promise<{ remoteId: string }>;
  deletePost(accountId: string, postId: string): Promise<string>;
}

export interface AgentDailyDraft {
  body: string;
  mode: 'DAILY';
  generatedBy: 'AGENT';
  draftId?: string;
}

export interface ThreadsIntegrationJournalEntry {
  runId: string;
  accountId: string;
  phase: string;
  status: 'STARTED' | 'PASSED' | 'WARNING' | 'FAILED' | 'UNCERTAIN' | 'CLEANUP_NEEDED';
  message: string;
  cleanupNeeded: boolean;
  remoteIds: { parentId?: string; replyId?: string; nestedId?: string };
  createdAt: string;
}

export type ThreadsIntegrationStatus = 'PASSED' | 'FAILED_SAFE' | 'CLEANUP_NEEDED';

export interface ThreadsIntegrationResult {
  runId: string;
  accountId: string;
  status: ThreadsIntegrationStatus;
  cleanupNeeded: boolean;
  remoteIds: { parentId?: string; replyId?: string; nestedId?: string };
  error?: string;
}

export interface ThreadsIntegrationDependencies {
  provider: ThreadsIntegrationProvider;
  supplyDailyDraft(input: { accountId: string; runId: string; maxBodyLength: number }): Promise<AgentDailyDraft>;
  journal(entry: ThreadsIntegrationJournalEntry): Promise<void> | void;
  isNotFound(error: unknown): boolean;
  isUncertain(error: unknown): boolean;
  wait?(milliseconds: number): Promise<void>;
  createRunId?(): string;
  now?(): Date;
  reconciliationDelaysMs?: readonly number[];
}

export interface ThreadsIntegrationInput {
  accountId: string;
  threadsUserId: string;
}

export interface ThreadsIntegrationRecoveryInput extends ThreadsIntegrationInput {
  runId: string;
  draftBody: string;
  parentId: string;
  replyId?: string;
  nestedId?: string;
}

interface RunContext {
  runId: string;
  accountId: string;
  ownerId: string;
  baselineIds: Set<string>;
  parentText?: string;
  replyText?: string;
  nestedText?: string;
  parentId?: string;
  replyId?: string;
  nestedId?: string;
  unresolvedMutation: boolean;
  cleanupBlocked: boolean;
  deleted: Set<string>;
  verified: Set<string>;
  externalReplyDetected: boolean;
}

const THREADS_TEXT_LIMIT = 500;

const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error)).slice(0, 1_000);

export class ThreadsIntegrationBusyError extends Error {
  constructor(accountId: string) {
    super(`계정 ${accountId}에서 Threads 통합 테스트가 이미 실행 중입니다.`);
    this.name = 'ThreadsIntegrationBusyError';
  }
}

export class ThreadsIntegrationService {
  private readonly activeAccounts = new Set<string>();
  private readonly wait: (milliseconds: number) => Promise<void>;
  private readonly createRunId: () => string;
  private readonly now: () => Date;
  private readonly delays: readonly number[];

  constructor(private readonly dependencies: ThreadsIntegrationDependencies) {
    this.wait = dependencies.wait ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
    this.createRunId = dependencies.createRunId ?? randomUUID;
    this.now = dependencies.now ?? (() => new Date());
    this.delays = dependencies.reconciliationDelaysMs?.length ? dependencies.reconciliationDelaysMs : [2_500];
  }

  async run(input: ThreadsIntegrationInput): Promise<ThreadsIntegrationResult> {
    if (!input.threadsUserId.trim()) throw new Error('Threads User ID가 없는 계정은 실제 통합 테스트를 실행할 수 없습니다.');
    if (this.activeAccounts.has(input.accountId)) throw new ThreadsIntegrationBusyError(input.accountId);
    this.activeAccounts.add(input.accountId);
    const context: RunContext = {
      runId:this.createRunId(), accountId:input.accountId, ownerId:input.threadsUserId,
      baselineIds:new Set(), unresolvedMutation:false, cleanupBlocked:false, deleted:new Set(), verified:new Set(), externalReplyDetected:false,
    };
    let functionalError: string | undefined;
    let flowCompleted = false;

    try {
      await this.record(context, 'RUN', 'STARTED', 'Threads 실제 통합 테스트를 시작합니다.');
      await this.preflight(context);
      await this.prepareTexts(context);
      await this.createParent(context);
      await this.createReply(context);
      await this.createNestedReply(context);
      flowCompleted = true;
      await this.record(context, 'FLOW', 'PASSED', '게시·답글·중첩 답글 생성과 관계 검증을 완료했습니다.');
    } catch (error) {
      functionalError = errorMessage(error);
      await this.record(context, 'FLOW', this.dependencies.isUncertain(error) ? 'UNCERTAIN' : 'FAILED', functionalError);
    }

    try {
      await this.cleanup(context);
    } catch (error) {
      context.cleanupBlocked = true;
      functionalError ??= errorMessage(error);
      await this.record(context, 'CLEANUP', 'CLEANUP_NEEDED', errorMessage(error));
    } finally {
      this.activeAccounts.delete(input.accountId);
    }

    const knownRemaining = [context.parentId, context.replyId, context.nestedId]
      .some((id) => Boolean(id && !context.deleted.has(id)));
    const cleanupNeeded = context.unresolvedMutation || context.cleanupBlocked || knownRemaining;
    const status: ThreadsIntegrationStatus = cleanupNeeded ? 'CLEANUP_NEEDED' : flowCompleted ? 'PASSED' : 'FAILED_SAFE';
    await this.record(context, 'RUN', cleanupNeeded ? 'CLEANUP_NEEDED' : status === 'PASSED' ? 'PASSED' : 'FAILED',
      cleanupNeeded ? '자동 정리가 확인되지 않은 테스트 항목이 있습니다.' : status === 'PASSED' ? '통합 테스트와 역순 정리를 모두 완료했습니다.' : '통합 테스트는 실패했지만 외부 테스트 항목은 남지 않았습니다.');
    return { runId:context.runId, accountId:context.accountId, status, cleanupNeeded,
      remoteIds:{ parentId:context.parentId, replyId:context.replyId, nestedId:context.nestedId }, error:functionalError };
  }

  async recover(input:ThreadsIntegrationRecoveryInput):Promise<ThreadsIntegrationResult> {
    if (this.activeAccounts.has(input.accountId)) throw new ThreadsIntegrationBusyError(input.accountId);
    this.activeAccounts.add(input.accountId);
    const context:RunContext={runId:input.runId,accountId:input.accountId,ownerId:input.threadsUserId,baselineIds:new Set(),
      parentText:`${input.draftBody.trim()}\n\n[Threads Auto 통합 테스트 PARENT ${input.runId}]`,
      replyText:`[Threads Auto 통합 테스트 REPLY ${input.runId}]`,nestedText:`[Threads Auto 통합 테스트 NESTED ${input.runId}]`,
      parentId:input.parentId,replyId:input.replyId,nestedId:input.nestedId,unresolvedMutation:false,cleanupBlocked:false,deleted:new Set(),verified:new Set(),externalReplyDetected:false};
    let failure:string|undefined;
    try { await this.record(context,'RECOVERY','STARTED','저장된 통합 테스트 ID와 고유 표식으로 API 정리를 다시 확인합니다.');await this.cleanup(context); }
    catch(error){context.cleanupBlocked=true;failure=errorMessage(error);await this.record(context,'RECOVERY','CLEANUP_NEEDED',failure);}
    finally{this.activeAccounts.delete(input.accountId);}
    const cleanupNeeded=context.cleanupBlocked||[context.nestedId,context.replyId,context.parentId].some(id=>Boolean(id&&!context.deleted.has(id)));
    await this.record(context,'RUN',cleanupNeeded?'CLEANUP_NEEDED':'PASSED',cleanupNeeded?'자동 정리가 확인되지 않은 테스트 항목이 있습니다.':'저장된 테스트 항목의 API 삭제 성공 응답을 확인했습니다.');
    return {runId:context.runId,accountId:context.accountId,status:cleanupNeeded?'CLEANUP_NEEDED':'PASSED',cleanupNeeded,
      remoteIds:{parentId:context.parentId,replyId:context.replyId,nestedId:context.nestedId},error:failure};
  }

  private ids(context: RunContext): ThreadsIntegrationJournalEntry['remoteIds'] {
    return { parentId:context.parentId, replyId:context.replyId, nestedId:context.nestedId };
  }

  private record(context: RunContext, phase: string, status: ThreadsIntegrationJournalEntry['status'], message: string): Promise<void> {
    return Promise.resolve(this.dependencies.journal({
      runId:context.runId, accountId:context.accountId, phase, status, message,
      cleanupNeeded:context.unresolvedMutation || context.cleanupBlocked,
      remoteIds:this.ids(context), createdAt:this.now().toISOString(),
    }));
  }

  private async preflight(context: RunContext): Promise<void> {
    await this.record(context, 'PREFLIGHT', 'STARTED', '저장된 Threads User ID와 로컬 실행 상태를 확인합니다.');
    if (!context.ownerId.trim()) throw new Error('Threads User ID가 없는 계정은 실제 통합 테스트를 실행할 수 없습니다.');
    await this.record(context, 'PREFLIGHT', 'PASSED', '불필요한 사전 API 조회 없이 고유 실행 ID로 테스트 대상을 구분합니다.');
  }

  private async prepareTexts(context: RunContext): Promise<void> {
    const parentMarker = `[Threads Auto 통합 테스트 PARENT ${context.runId}]`;
    const available = THREADS_TEXT_LIMIT - parentMarker.length - 2;
    const draft = await this.dependencies.supplyDailyDraft({ accountId:context.accountId, runId:context.runId, maxBodyLength:available });
    if (draft.mode !== 'DAILY' || draft.generatedBy !== 'AGENT') throw new Error('Agent가 생성한 일상 초안만 실제 통합 테스트에 사용할 수 있습니다.');
    const body = draft.body.trim();
    if (!body || body.length > available) throw new Error(`Agent 일상 초안은 1~${available}자여야 합니다.`);
    context.parentText = `${body}\n\n${parentMarker}`;
    context.replyText = `[Threads Auto 통합 테스트 REPLY ${context.runId}]`;
    context.nestedText = `[Threads Auto 통합 테스트 NESTED ${context.runId}]`;
    await this.record(context, 'DRAFT', 'PASSED', 'Agent 일상 초안과 고유 테스트 표식을 준비했습니다.');
  }

  private async createParent(context: RunContext): Promise<void> {
    await this.record(context, 'PARENT_PUBLISH', 'STARTED', '고유 부모 게시물 발행을 요청합니다.');
    try {
      const published = await this.dependencies.provider.publish(context.accountId, { text:context.parentText! });
      context.parentId = published.remoteId;
      await this.record(context, 'PARENT_ID', 'PASSED', '부모 게시물 원격 ID를 journal에 기록했습니다.');
    } catch (error) {
      if (!this.dependencies.isUncertain(error)) throw error;
      context.unresolvedMutation = true;
      await this.record(context, 'PARENT_PUBLISH', 'UNCERTAIN', '부모 게시물 발행 결과를 조회로 조정합니다. 재발행하지 않습니다.');
      const resolved = await this.reconcileCollection(context, () => this.dependencies.provider.ownPosts(context.accountId, 50),
        (post) => this.parentDiscoveryMatches(context, post) && !context.baselineIds.has(post.id));
      if (!resolved) throw error;
      context.parentId = resolved.id;
      await this.record(context, 'PARENT_ID', 'PASSED', '조회로 조정한 부모 게시물 원격 ID를 journal에 기록했습니다.');
      context.unresolvedMutation = false;
    }
    const verified = await this.dependencies.provider.getPost(context.accountId,context.parentId!);
    this.assertParent(context, verified);
    context.verified.add(context.parentId!);
    await this.record(context, 'PARENT_PUBLISH', 'PASSED', '부모 게시물 ID와 소유자·본문을 확인했습니다.');
  }

  private async createReply(context: RunContext): Promise<void> {
    await this.record(context, 'REPLY_PUBLISH', 'STARTED', '부모 게시물에 테스트 답글을 발행합니다.');
    try {
      const published = await this.dependencies.provider.reply(context.accountId, context.parentId!, context.replyText!);
      context.replyId = published.remoteId;
      await this.record(context, 'REPLY_ID', 'PASSED', '답글 원격 ID를 journal에 기록했습니다.');
    } catch (error) {
      if (!this.dependencies.isUncertain(error)) throw error;
      context.unresolvedMutation = true;
      await this.record(context, 'REPLY_PUBLISH', 'UNCERTAIN', '답글 발행 결과를 replies API로 조정합니다. 재발행하지 않습니다.');
      const resolved = await this.reconcileCollection(context, () => this.dependencies.provider.replies(context.accountId, context.parentId!),
        (post) => this.replyMatches(context, post));
      if (!resolved) throw error;
      context.replyId = resolved.id;
      await this.record(context, 'REPLY_ID', 'PASSED', '조회로 조정한 답글 원격 ID를 journal에 기록했습니다.');
      context.unresolvedMutation = false;
    }
    await this.record(context, 'REPLY_PUBLISH', 'PASSED', '답글 ID를 기록했습니다. 부모 관계는 중첩 답글과 함께 한 번만 확인합니다.');
  }

  private async createNestedReply(context: RunContext): Promise<void> {
    await this.record(context, 'NESTED_PUBLISH', 'STARTED', '테스트 답글에 중첩 답글을 발행합니다.');
    try {
      const published = await this.dependencies.provider.reply(context.accountId, context.replyId!, context.nestedText!);
      context.nestedId = published.remoteId;
      await this.record(context, 'NESTED_ID', 'PASSED', '중첩 답글 원격 ID를 journal에 기록했습니다.');
    } catch (error) {
      if (!this.dependencies.isUncertain(error)) throw error;
      context.unresolvedMutation = true;
      await this.record(context, 'NESTED_PUBLISH', 'UNCERTAIN', '중첩 답글 결과를 conversation API로 조정합니다. 재발행하지 않습니다.');
      const resolved = await this.reconcileCollection(context, () => this.dependencies.provider.conversation(context.accountId, context.parentId!),
        (post) => this.nestedMatches(context, post));
      if (!resolved) throw error;
      context.nestedId = resolved.id;
      await this.record(context, 'NESTED_ID', 'PASSED', '조회로 조정한 중첩 답글 원격 ID를 journal에 기록했습니다.');
      context.unresolvedMutation = false;
    }
    if (this.delays[0] > 0) await this.wait(this.delays[0]);
    const conversation = await this.dependencies.provider.conversation(context.accountId, context.parentId!);
    const reply = conversation.find((post) => post.id === context.replyId && this.replyMatches(context, post));
    const nested = conversation.find((post) => post.id === context.nestedId && this.nestedMatches(context, post));
    if (!reply || !nested) throw new Error('conversation API 1회 조회에서 댓글·대댓글 관계를 확인하지 못했습니다. 반복 조회는 수행하지 않습니다.');
    const expected = new Set([context.replyId, context.nestedId]);
    const external = conversation.filter((post) => !expected.has(post.id));
    if (external.length) {
      context.externalReplyDetected = true;
      context.cleanupBlocked = true;
      throw new Error('테스트 부모 게시물에 외부 답글이 감지되어 부모 게시물은 자동 삭제하지 않습니다.');
    }
    context.verified.add(context.replyId!);
    context.verified.add(context.nestedId!);
    await this.record(context, 'NESTED_PUBLISH', 'PASSED', 'conversation API 1회로 댓글·대댓글의 root·replied_to 관계를 확인했습니다.');
  }

  private parentMatches(context: RunContext, post: ThreadsIntegrationPost): boolean {
    return post.ownerId === context.ownerId && post.text === context.parentText && post.isReply === false;
  }

  private parentDiscoveryMatches(context: RunContext, post: ThreadsIntegrationPost): boolean {
    return post.ownerId === context.ownerId && post.text === context.parentText && post.isReply !== true;
  }

  private replyMatches(context: RunContext, post: ThreadsIntegrationPost): boolean {
    return (post.ownerId === context.ownerId || post.isReplyOwnedByMe === true) && post.text === context.replyText && post.isReply === true
      && post.rootPostId === context.parentId && post.repliedToId === context.parentId;
  }

  private nestedMatches(context: RunContext, post: ThreadsIntegrationPost): boolean {
    return (post.ownerId === context.ownerId || post.isReplyOwnedByMe === true) && post.text === context.nestedText && post.isReply === true
      && post.rootPostId === context.parentId && post.repliedToId === context.replyId;
  }

  private assertParent(context: RunContext, post: ThreadsIntegrationPost): void {
    if (post.id !== context.parentId || !this.parentMatches(context, post) || context.baselineIds.has(post.id)) {
      throw new Error('부모 게시물의 ID·소유자·본문 검증에 실패했습니다.');
    }
  }

  private async reconcileCollection(
    context: RunContext,
    load: () => Promise<ThreadsIntegrationPost[]>,
    matches: (post: ThreadsIntegrationPost) => boolean,
  ): Promise<ThreadsIntegrationPost | undefined> {
    for (const delay of this.delays) {
      if (delay > 0) await this.wait(delay);
      try {
        const candidates = (await load()).filter(matches);
        if (candidates.length > 1) {
          context.unresolvedMutation = true;
          throw new Error('동일한 테스트 표식의 원격 항목이 여러 개여서 자동 조정을 중단합니다.');
        }
        if (candidates.length === 1) return candidates[0];
      } catch (error) {
        if (/여러 개/.test(errorMessage(error))) throw error;
      }
    }
    return undefined;
  }

  private async cleanup(context: RunContext): Promise<void> {
    await this.record(context, 'CLEANUP', 'STARTED', '중첩 답글부터 부모 게시물까지 역순 정리를 시작합니다.');
    if (context.nestedId) await this.deleteNested(context);
    if (context.replyId) await this.deleteReply(context);
    if (context.parentId) await this.deleteParent(context);
    if (!context.unresolvedMutation && !context.cleanupBlocked
      && [context.nestedId, context.replyId, context.parentId].every((id) => !id || context.deleted.has(id))) {
      await this.record(context, 'CLEANUP', 'PASSED', '테스트 원격 항목의 역순 DELETE 성공 응답을 모두 확인했습니다.');
    }
  }

  private async deleteNested(context: RunContext): Promise<void> {
    if (context.verified.has(context.nestedId!)) return this.deleteAndConfirm(context,context.nestedId!,()=>this.dependencies.provider.conversation(context.accountId,context.parentId!));
    const post = await this.safeGet(context, context.nestedId!);
    if (!post) { context.deleted.add(context.nestedId!); return; }
    if (!this.nestedMatches(context, post)) return this.blockCleanup(context, '중첩 답글 소유자 또는 관계가 달라 삭제하지 않았습니다.');
    const conversation = await this.dependencies.provider.conversation(context.accountId, context.parentId!);
    if (this.descendants(conversation, context.nestedId!).length) return this.blockCleanup(context, '중첩 답글 아래 외부 답글이 있어 삭제하지 않았습니다.');
    await this.deleteAndConfirm(context, context.nestedId!, () => this.dependencies.provider.conversation(context.accountId, context.parentId!));
  }

  private async deleteReply(context: RunContext): Promise<void> {
    if (context.verified.has(context.replyId!) && (!context.nestedId || context.deleted.has(context.nestedId))) {
      return this.deleteAndConfirm(context,context.replyId!,()=>this.dependencies.provider.conversation(context.accountId,context.parentId!));
    }
    const post = await this.safeGet(context, context.replyId!);
    if (!post) { context.deleted.add(context.replyId!); return; }
    if (!this.replyMatches(context, post)) return this.blockCleanup(context, '답글 소유자 또는 부모 관계가 달라 삭제하지 않았습니다.');
    const conversation = await this.dependencies.provider.conversation(context.accountId, context.parentId!);
    if (this.descendants(conversation, context.replyId!).length) return this.blockCleanup(context, '테스트 답글 아래 삭제되지 않은 답글이 있어 삭제하지 않았습니다.');
    await this.deleteAndConfirm(context, context.replyId!, () => this.dependencies.provider.conversation(context.accountId, context.parentId!));
  }

  private async deleteParent(context: RunContext): Promise<void> {
    if (context.verified.has(context.parentId!) && !context.externalReplyDetected
      && (!context.replyId || context.deleted.has(context.replyId)) && (!context.nestedId || context.deleted.has(context.nestedId))) {
      return this.deleteAndConfirm(context,context.parentId!,()=>this.dependencies.provider.ownPosts(context.accountId,50));
    }
    const post = await this.safeGet(context, context.parentId!);
    if (!post) { context.deleted.add(context.parentId!); return; }
    if (!this.parentMatches(context, post) || context.baselineIds.has(post.id)) return this.blockCleanup(context, '부모 게시물 소유자 또는 본문이 달라 삭제하지 않았습니다.');
    const conversation = await this.dependencies.provider.conversation(context.accountId, context.parentId!);
    if (conversation.length) return this.blockCleanup(context, '부모 게시물에 답글이 남아 있어 외부 댓글 보호를 위해 삭제하지 않았습니다.');
    await this.deleteAndConfirm(context, context.parentId!, () => this.dependencies.provider.ownPosts(context.accountId, 50));
  }

  private descendants(conversation: ThreadsIntegrationPost[], ancestorId: string): ThreadsIntegrationPost[] {
    const ids = new Set([ancestorId]);
    const found: ThreadsIntegrationPost[] = [];
    let changed = true;
    while (changed) {
      changed = false;
      for (const post of conversation) {
        if (!found.some((item) => item.id === post.id) && post.repliedToId && ids.has(post.repliedToId)) {
          found.push(post); ids.add(post.id); changed = true;
        }
      }
    }
    return found;
  }

  private async safeGet(context: RunContext, postId: string): Promise<ThreadsIntegrationPost | undefined> {
    try { return await this.dependencies.provider.getPost(context.accountId, postId); }
    catch (error) {
      if (this.dependencies.isNotFound(error)) return undefined;
      context.cleanupBlocked = true;
      throw error;
    }
  }

  private async blockCleanup(context: RunContext, message: string): Promise<void> {
    context.cleanupBlocked = true;
    await this.record(context, 'CLEANUP', 'CLEANUP_NEEDED', message);
  }

  private async deleteAndConfirm(context: RunContext, postId: string, collection: () => Promise<ThreadsIntegrationPost[]>): Promise<void> {
    await this.record(context, 'DELETE', 'STARTED', `검증된 테스트 항목 ${postId} 삭제를 요청합니다.`);
    let uncertain = false;
    try {
      const deletedId = await this.dependencies.provider.deletePost(context.accountId, postId);
      if (deletedId !== postId) throw new Error('Threads 삭제 응답 ID가 요청한 테스트 항목과 다릅니다.');
    } catch (error) {
      uncertain = this.dependencies.isUncertain(error);
      if (!uncertain) {
        context.cleanupBlocked = true;
        throw error;
      }
      await this.record(context, 'DELETE', 'UNCERTAIN', `삭제 응답이 불확실하여 ${postId} 부재 여부만 조회합니다. 삭제를 재시도하지 않습니다.`);
    }
    if(!uncertain){
      context.deleted.add(postId);
      await this.record(context,'DELETE','PASSED',`테스트 항목 ${postId}의 DELETE 성공 응답과 deleted_id를 확인했습니다.`);
      return;
    }
    const absent = await this.confirmAbsent(context, postId, collection);
    if (!absent) {
      context.cleanupBlocked = true;
      if (uncertain) context.unresolvedMutation = true;
      await this.record(context, 'DELETE', 'CLEANUP_NEEDED', `테스트 항목 ${postId}의 삭제를 확인하지 못했습니다.`);
      return;
    }
    context.deleted.add(postId);
    await this.record(context, 'DELETE', 'PASSED', `테스트 항목 ${postId}의 삭제와 부재를 확인했습니다.`);
  }

  private async confirmAbsent(context: RunContext, postId: string, collection: () => Promise<ThreadsIntegrationPost[]>): Promise<boolean> {
    for (const delay of this.delays) {
      if (delay > 0) await this.wait(delay);
      try {
        await this.dependencies.provider.getPost(context.accountId, postId);
        continue;
      } catch (error) {
        if (!this.dependencies.isNotFound(error)) continue;
      }
      try {
        if (!(await collection()).some((post) => post.id === postId)) return true;
      } catch { /* 다음 bounded 조회에서 다시 확인한다. */ }
    }
    return false;
  }
}
