import type { Account, PostRecord, ThreadsPostSummary } from '../../shared/domain';
import type { ThreadsProvider } from '../providers/contracts';
import { isThreadsRemoteObjectMissing } from '../providers/threads-error-classification';

export interface OwnedReplyRecord {
  id: string;
  accountId: string;
  postId: string;
  replyId?: string;
  replyStatus?: string;
  replyDeletedAt?: string;
}

interface OwnedContentRepository {
  getAccount(id: string): Account | undefined;
  getPost(id: string): PostRecord | undefined;
  getComment(id: string, accountId?: string): OwnedReplyRecord | undefined;
  markPostRemoteDeleted(id: string): void;
  recordCoupangReplyDeleted(postId:string, accountId:string): unknown;
  recordCoupangReplyDeleteFailure(postId:string, accountId:string, error:string): unknown;
  recordCommentReplyDeleted(input: { id:string; accountId:string }): unknown;
  recordCommentReplyDeleteFailure(input: { id:string; accountId:string; error:string }): unknown;
  addLog(level: 'INFO' | 'WARN' | 'ERROR', category: string, message: string, detail?: string, accountId?: string): unknown;
}

export interface OwnedContentDeleteResult {
  deletedId: string;
  verifiedAbsent: boolean;
  message: string;
}

const delay = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));

export class ThreadsOwnedContentService {
  constructor(
    private readonly repositories: OwnedContentRepository,
    private readonly threads: Pick<ThreadsProvider, 'getPost' | 'deletePost'>,
    private readonly wait: (milliseconds: number) => Promise<unknown> = delay,
  ) {}

  private account(accountId: string): Account & { threadsUserId: string } {
    const account = this.repositories.getAccount(accountId);
    if (!account?.threadsUserId) throw new Error('Threads 연결이 확인된 계정을 선택하세요.');
    return account as Account & { threadsUserId: string };
  }

  private async confirmAbsent(accountId: string, remoteId: string): Promise<boolean> {
    for (const waitMs of [0, 400, 1_000, 2_000]) {
      if (waitMs) await this.wait(waitMs);
      try { await this.threads.getPost(accountId, remoteId); }
      catch (error) { if (isThreadsRemoteObjectMissing(error)) return true; else throw error; }
    }
    return false;
  }

  private assertOwner(remote: ThreadsPostSummary, threadsUserId: string): void {
    if (!remote.id || remote.ownerId !== threadsUserId) {
      throw new Error('현재 계정이 직접 작성한 Threads 콘텐츠만 삭제할 수 있습니다.');
    }
  }

  async deletePost(accountId: string, localPostId: string): Promise<OwnedContentDeleteResult> {
    const account = this.account(accountId);
    const post = this.repositories.getPost(localPostId);
    if (!post || post.accountId !== accountId) throw new Error('선택한 계정의 게시 이력을 찾을 수 없습니다.');
    if (!post.threadsPostId) throw new Error('Threads에 발행된 본문만 삭제할 수 있습니다.');
    if (post.remoteDeletedAt) throw new Error('이미 삭제 처리된 본문입니다.');
    if (post.sourceType==='COUPANG' && post.coupangReplyId && post.coupangReplyStatus!=='DELETED') {
      try {
        const reply=await this.threads.getPost(accountId,post.coupangReplyId);
        this.assertOwner(reply,account.threadsUserId);
        if (reply.id!==post.coupangReplyId || reply.isReply!==true || (reply.repliedToId&&reply.repliedToId!==post.threadsPostId)) {
          throw new Error('이전 방식 쿠팡 안내 댓글과 본문의 관계가 일치하지 않아 삭제하지 않았습니다.');
        }
        const deletedReplyId=await this.threads.deletePost(accountId,reply.id);
        if (deletedReplyId!==reply.id) throw new Error('Threads 이전 안내 댓글 삭제 응답 ID가 요청 ID와 다릅니다.');
        await this.confirmAbsent(accountId,reply.id);
        this.repositories.recordCoupangReplyDeleted(localPostId,accountId);
      } catch (error) {
        this.repositories.recordCoupangReplyDeleteFailure(localPostId,accountId,error instanceof Error?error.message:String(error));
        throw new Error(`이전 방식 쿠팡 안내 댓글을 먼저 삭제하지 못해 본문 삭제를 중단했습니다. ${error instanceof Error?error.message:String(error)}`,{cause:error});
      }
    }
    const remote = await this.threads.getPost(accountId, post.threadsPostId);
    this.assertOwner(remote, account.threadsUserId);
    if (remote.id !== post.threadsPostId || remote.isReply === true) throw new Error('본문 ID와 원격 콘텐츠 관계가 일치하지 않아 삭제하지 않았습니다.');
    const deletedId = await this.threads.deletePost(accountId, remote.id);
    if (deletedId !== remote.id) throw new Error('Threads 삭제 응답 ID가 요청한 본문 ID와 다릅니다.');
    const verifiedAbsent = await this.confirmAbsent(accountId, remote.id);
    this.repositories.markPostRemoteDeleted(localPostId);
    this.repositories.addLog(verifiedAbsent ? 'INFO' : 'WARN', 'THREADS_DELETE', verifiedAbsent
      ? '직접 작성한 Threads 본문을 삭제하고 부재를 확인했습니다.'
      : 'Threads 본문 삭제 요청은 완료됐지만 원격 부재 확인이 지연되고 있습니다.', undefined, accountId);
    return { deletedId, verifiedAbsent, message:verifiedAbsent ? '본문을 삭제했습니다.' : '삭제 요청을 완료했습니다. 원격 반영을 확인 중입니다.' };
  }

  async deleteReply(accountId: string, localCommentId: string): Promise<OwnedContentDeleteResult> {
    const account = this.account(accountId);
    const comment = this.repositories.getComment(localCommentId, accountId);
    if (!comment || comment.accountId !== accountId) throw new Error('선택한 계정의 댓글 처리 이력을 찾을 수 없습니다.');
    if (!comment.replyId) throw new Error('프로그램이 작성한 답글이 없어 삭제할 수 없습니다.');
    if (comment.replyDeletedAt || comment.replyStatus === 'DELETED') throw new Error('이미 삭제 처리된 답글입니다.');
    try {
      const remote = await this.threads.getPost(accountId, comment.replyId);
      this.assertOwner(remote, account.threadsUserId);
      if (remote.id !== comment.replyId || remote.isReply !== true || (remote.repliedToId && remote.repliedToId !== comment.id)) {
        throw new Error('답글 ID와 원래 댓글의 관계가 일치하지 않아 삭제하지 않았습니다.');
      }
      const deletedId = await this.threads.deletePost(accountId, remote.id);
      if (deletedId !== remote.id) throw new Error('Threads 삭제 응답 ID가 요청한 답글 ID와 다릅니다.');
      const verifiedAbsent = await this.confirmAbsent(accountId, remote.id);
      this.repositories.recordCommentReplyDeleted({ id:localCommentId, accountId });
      this.repositories.addLog(verifiedAbsent ? 'INFO' : 'WARN', 'THREADS_DELETE', verifiedAbsent
        ? '프로그램이 작성한 Threads 답글을 삭제하고 부재를 확인했습니다.'
        : 'Threads 답글 삭제 요청은 완료됐지만 원격 부재 확인이 지연되고 있습니다.', undefined, accountId);
      return { deletedId, verifiedAbsent, message:verifiedAbsent ? '답글을 삭제했습니다.' : '삭제 요청을 완료했습니다. 원격 반영을 확인 중입니다.' };
    } catch (error) {
      this.repositories.recordCommentReplyDeleteFailure({ id:localCommentId, accountId, error:error instanceof Error ? error.message : String(error) });
      throw error;
    }
  }
}
