import { Fragment, useState } from 'react';
import type { ReportRow } from '../shared/domain';

export function PostPerformanceTable({ rows, formatDate, formatNumber }: {
  rows: ReportRow[];
  formatDate: (value?: string) => string;
  formatNumber: (value: number) => string;
}) {
  const [expanded, setExpanded] = useState<string>();
  const toggle = (id: string) => setExpanded(current => current === id ? undefined : id);
  return <div className="table-wrap"><table className="post-performance-table">
    <thead><tr><th>계정</th><th>게시일</th><th>유형</th><th>조회</th><th>좋아요</th><th>댓글</th><th>리포스트</th><th>인용</th><th>공유</th><th>게시물</th></tr></thead>
    <tbody>{rows.map(row => <Fragment key={row.postId}>
      <tr className="performance-summary-row" onClick={() => toggle(row.postId)}>
        <td>{row.accountName}</td><td>{formatDate(row.publishedAt)}</td><td>{row.sourceType}</td>
        <td>{formatNumber(row.views)}</td><td>{formatNumber(row.likes)}</td><td>{formatNumber(row.replies)}</td>
        <td>{formatNumber(row.reposts)}</td><td>{formatNumber(row.quotes)}</td><td>{formatNumber(row.shares)}</td>
        <td><button type="button" aria-label={`${row.accountName} ${formatDate(row.publishedAt)} 게시물 본문 ${expanded === row.postId ? '접기' : '보기'}`}
          aria-expanded={expanded === row.postId} aria-controls={`post-body-${row.postId}`}
          onClick={event => { event.stopPropagation(); toggle(row.postId); }}>{expanded === row.postId ? '접기' : '본문 보기'}</button></td>
      </tr>
      <tr hidden={expanded !== row.postId} id={`post-body-${row.postId}`} className="performance-body-row"><td colSpan={10}>
        <article aria-label={`${row.accountName} 게시물 본문`}><strong>등록된 본문</strong><p>{row.body || '저장된 본문이 없습니다.'}</p></article>
      </td></tr>
    </Fragment>)}</tbody>
  </table></div>;
}
