"use strict";
const {sendJson,sendError}=require('../router');
const plans=require('../repo/plan.repo'),history=require('../repo/plan-history.repo');
function register(router) {
  router.add('GET','/api/cooperation-history',c=>{
    const id=c.user.id;
    const pairs=c.db.prepare(`SELECT supervisor_id,supervisee_id FROM supervision_relations WHERE supervisor_id=? OR supervisee_id=?
      UNION SELECT creator_id,assignee_id FROM plans WHERE (creator_id=? OR assignee_id=?) AND creator_id<>assignee_id`).all(id,id,id,id);
    if (!pairs.length) return sendJson(c.res,200,{list:[]});
    const key = pair => `${pair.supervisor_id}\u0000${pair.supervisee_id}`;
    const peopleIds=[...new Set(pairs.flatMap(pair=>[pair.supervisor_id,pair.supervisee_id]))];
    const personSlots=peopleIds.map(()=>'?').join(',');
    const people=new Map(c.db.prepare(`SELECT id,display_name FROM users WHERE id IN (${personSlots})`).all(...peopleIds).map(row=>[row.id,row.display_name]));
    const wanted=new Set(pairs.map(key));
    const relations=new Map(c.db.prepare('SELECT supervisor_id,supervisee_id,status FROM supervision_relations WHERE supervisor_id=? OR supervisee_id=?').all(id,id)
      .filter(row=>wanted.has(key(row))).map(row=>[key(row),row.status]));
    const periods=new Map();
    for(const row of c.db.prepare('SELECT id,supervisor_id,supervisee_id,started_at AS startedAt,ended_at AS endedAt FROM supervision_periods WHERE supervisor_id=? OR supervisee_id=? ORDER BY started_at DESC,id DESC').all(id,id)){
      const pairKey=key(row);if(!wanted.has(pairKey))continue;
      if(!periods.has(pairKey))periods.set(pairKey,[]);
      periods.get(pairKey).push({id:row.id,startedAt:row.startedAt,endedAt:row.endedAt});
    }
    const list=pairs.map(pair=>{
      const otherId=pair.supervisor_id===id?pair.supervisee_id:pair.supervisor_id;
      const pairKey=key(pair);
      return {personId:otherId,displayName:people.get(otherId)||'历史合作对象',active:relations.get(pairKey)==='active',periods:periods.get(pairKey)||[]};
    });
    sendJson(c.res,200,{list});
  });
  router.add('GET','/api/cooperation-history/plans',c=>{
    const personId=String(c.query.personId||''),q=String(c.query.q||'').trim().slice(0,100);
    const periodId=String(c.query.periodId||'');
    const offset=Math.min(Number.MAX_SAFE_INTEGER,Math.max(0,parseInt(c.query.offset,10)||0)),limit=30;
    const rows=c.db.prepare(`SELECT p.* FROM plans p WHERE (p.creator_id=? OR p.assignee_id=?)
      AND (?='' OR p.creator_id=? OR p.assignee_id=?)
      AND (?='' OR p.cooperation_period_id=? OR (?='unassigned' AND p.cooperation_period_id IS NULL))
      AND (p.parent_id IS NULL OR NOT EXISTS(SELECT 1 FROM plans parent WHERE parent.id=p.parent_id))
      AND (?='' OR instr(p.title,?)>0 OR EXISTS(SELECT 1 FROM plans child WHERE child.parent_id=p.id AND instr(child.title,?)>0))
      ORDER BY p.created_at DESC,p.id DESC LIMIT ? OFFSET ?`).all(c.user.id,c.user.id,personId,personId,personId,periodId,periodId,periodId,q,q,q,limit+1,offset);
    sendJson(c.res,200,{plans:history.serialize(c.db,rows.slice(0,limit),c.user),nextOffset:rows.length>limit?offset+limit:null});
  });
  router.add('GET','/api/cooperation-history/plans/:id',c=>{
    const root=plans.byId(c.db,c.params.id);
    if(!root||![root.creator_id,root.assignee_id].includes(c.user.id))return sendError(c.res,404,'合作记录不存在');
    const rows=c.db.prepare(`WITH RECURSIVE tree(id) AS (SELECT id FROM plans WHERE id=? UNION SELECT p.id FROM plans p JOIN tree t ON p.parent_id=t.id WHERE p.creator_id=? AND p.assignee_id=?) SELECT p.* FROM plans p JOIN tree t ON t.id=p.id ORDER BY p.start_at,p.created_at,p.id`).all(root.id,root.creator_id,root.assignee_id);
    const records=history.withDetails(c.db,history.serialize(c.db,rows,c.user),c.user);
    sendJson(c.res,200,{rootId:root.id,records});
  });
}
module.exports={register};
