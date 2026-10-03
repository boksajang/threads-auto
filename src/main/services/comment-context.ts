import type { CommentListInput, Repositories } from '../db/repositories';
import type { ThreadsProvider } from '../providers/contracts';

export function threadsPermalink(value?:string):string|undefined {
  if(!value)return undefined;
  try {const url=new URL(value);return url.protocol==='https:'&&!url.username&&!url.password&&['threads.net','www.threads.net','threads.com','www.threads.com'].includes(url.hostname)?url.toString():undefined;}
  catch{return undefined;}
}

export class CommentContextService {
  private readonly pending=new Map<string,Promise<void>>();
  constructor(private readonly repositories:Repositories,private readonly threads:Pick<ThreadsProvider,'getPost'>){}

  private async fetchParent(accountId:string,postId:string):Promise<void> {
    const key=JSON.stringify([accountId,postId]);
    const pending=this.pending.get(key);if(pending)return pending;
    const request=(async()=>{
      try {
        const parent=await this.threads.getPost(accountId,postId);
        if(parent.id!==postId)throw new Error('원문 게시물 ID가 일치하지 않습니다.');
        this.repositories.saveCommentParent({accountId,postId,body:parent.text??'',permalink:threadsPermalink(parent.permalink),publishedAt:parent.timestamp});
      } catch { /* 권한·통신 오류를 삭제로 판정하거나 캐시에 저장하지 않는다. 다음 새로고침에서 재시도한다. */ }
    })();
    this.pending.set(key,request);
    try{await request;}finally{this.pending.delete(key);}
  }

  async list(input:CommentListInput,fetchMissing=true) {
    const items=this.repositories.listComments(input);
    if(fetchMissing){
      const missing=[...new Set(items.filter(item=>item.postBody===undefined).map(item=>item.postId))];
      let next=0;
      await Promise.all(Array.from({length:Math.min(3,missing.length)},async()=>{
        while(next<missing.length){const postId=missing[next++];await this.fetchParent(input.accountId,postId);}
      }));
    }
    return {summary:this.repositories.commentSummary(input.accountId,input.postId),items:this.repositories.listComments(input)};
  }
}
