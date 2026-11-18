import { classifyLocal } from './nlu-local';
import { studentTimetable } from './manual-timetable';
/** Reuse existing academic grammar; unsupported filtered queries remain in their existing path. */
export async function requestedStudentTimetable(db:D1Database,text:string,reference:Date):Promise<string|null>{
 const request=classifyLocal(text);
 if(!request||request.intent!=='schedule'||request.course||request.teacher||request.lab||request.slot||request.kind||request.labsOnly)return null;
 if(!['today','tomorrow','weekday','week','unspecified'].includes(request.day))return null;
 const day=request.day==='weekday'?request.weekday!:request.day==='today'||request.day==='tomorrow'?request.day:undefined;
 return studentTimetable(db,day,reference,request.group??undefined);
}
