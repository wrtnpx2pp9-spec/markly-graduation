'use strict';
const crypto=require('crypto');
const users=require('./user.repo');
const profiles=require('./profile.repo');
function details(db,user) {
  return {...users.toPublic(user),agreementRef:user.agreement_ref||'',cooperationNote:user.cooperation_note||'',
    cooperationReviewedBy:user.cooperation_reviewed_by,cooperationReviewedAt:user.cooperation_reviewed_at,
    directoryPublished:profiles.own(db,user.id).published};
}
function save(db,user,actorId,{state,capacity,agreementRef,note,published}) {
  const before=details(db,user),now=Date.now();
  db.prepare('UPDATE users SET cooperation_state=?,capacity_override=?,agreement_ref=?,cooperation_note=?,cooperation_reviewed_by=?,cooperation_reviewed_at=? WHERE id=?')
    .run(state,capacity,agreementRef,note,actorId,now,user.id);
  profiles.save(db,user.id,{...profiles.own(db,user.id),published:state==='active'&&published,accepting:state==='active'});
  const after=details(db,users.byId(db,user.id));
  db.prepare('INSERT INTO cooperation_events(id,supervisor_id,actor_id,before_json,after_json,created_at) VALUES (?,?,?,?,?,?)')
    .run(crypto.randomUUID(),user.id,actorId,JSON.stringify(before),JSON.stringify(after),now);
  return after;
}
module.exports={details,save};
