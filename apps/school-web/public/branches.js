const escape = value => String(value ?? '').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&#39;');
const percent = value => value == null ? 'No data' : `${Number(value).toFixed(1)}%`;
const money = value => `D${(Number(value || 0)/100).toLocaleString('en-GB',{minimumFractionDigits:2,maximumFractionDigits:2})}`;
function table(headers, rows) {
  return `<div class="table-wrap"><table><thead><tr>${headers.map(h=>`<th scope="col">${escape(h)}</th>`).join('')}</tr></thead><tbody>${rows || `<tr><td colspan="${headers.length}">No matching records yet.</td></tr>`}</tbody></table></div>`;
}
export async function mountBranches(host, api, currentSchool) {
  host.textContent = 'Loading branches…';
  try {
    const data = await api('/api/branches');
    const schools = data.managedSchools || [];
    if (!host.isConnected) return;
    const ownerGroups = data.groups.filter(g=>g.canCompare);
    const branchName = id => data.branches.find(b=>b.id===id)?.name || id;
    const schoolOptions = schools.map(s=>`<option value="${escape(s.id)}">${escape(s.name)}</option>`).join('');
    const currentGroup = data.groups.find(g => data.branches.some(b => b.id === currentSchool?.id && b.group_id === g.id));
    const canCreate = currentSchool && (!currentGroup || currentGroup.ownerSchoolId === currentSchool.id);
    host.innerHTML = `<section class="panel"><h2>Your school workspaces</h2><p>Currently open: <strong>${escape(currentSchool?.name || '')}</strong>. Open a workspace before entering or editing its students, attendance, results or payments.</p>${table(['School / branch','Open records'],schools.map(s=>`<tr><td>${escape(s.name)}</td><td><a href="/?school=${encodeURIComponent(s.id)}#overview">Open ${escape(s.name)}</a></td></tr>`).join(''))}</section>
      ${canCreate ? `<section class="panel"><h2>Add branch</h2><p>Create an outlet under ${escape(currentSchool.name)}. It will be linked automatically, and its administrator will receive an email invitation.</p><form id="branch-create" class="form-grid">
      <label>Branch name<input name="name" maxlength="150" required placeholder="Brusubi campus"></label>
      <label>Region<input name="region" maxlength="150" required placeholder="West Coast Region"></label>
      <label>Town / location<input name="town" maxlength="150" required placeholder="Brusubi"></label>
      <label>Headmaster / administrator name<input name="adminName" maxlength="150" required></label>
      <label>Administrator email<input type="email" name="adminEmail" maxlength="150" required></label>
      <label>Contact phone<input type="tel" name="phone" maxlength="150"></label>
      <p class="note">Each branch keeps separate records. The administrator manages this outlet; main-school leaders compare all linked branches. Creating an outlet does not start another free trial.</p>
      <button class="button">Create branch &amp; invite administrator</button></form></section>` : '<section class="panel"><p>New outlets are added from the main school account. Your branch administrator access covers this outlet.</p></section>'}
      ${schools.length ? `<section class="panel"><h2>Link school branches</h2><p>School owners and headmasters can link the outlets they administer. Administrators of the selected main school can compare the linked branches.</p><form id="branch-setup" class="stack"><label>Organisation name <input name="name" maxlength="120" required></label><label>Main school <select name="ownerSchoolId" required>${schoolOptions}</select></label><fieldset><legend>Branches to link</legend>${schools.map(s=>`<label style="display:block"><input type="checkbox" name="schoolIds" value="${escape(s.id)}"> ${escape(s.name)}</label>`).join('')}</fieldset><p class="note">Your main school is included automatically. Only schools where your account has administrator access are listed. Use your school leadership account with access to each outlet.</p><button class="button">Link selected branches</button></form></section>` : ''}
      <p id="branch-message" role="status"></p>
      ${data.groups.length ? `<section class="panel"><h2>Your branch groups</h2>${data.groups.map(g=>`<p><strong>${escape(g.name)}</strong> · ${g.canCompare ? 'Overall comparison access' : 'Your branch records and explanations'}</p>`).join('')}</section>` : '<section class="panel"><p>Use Add branch to create your first outlet. If your outlets already have workspaces, use Link school branches below.</p></section>'}
      ${ownerGroups.length ? `<section class="panel"><h2>Match a course assessment</h2><p>Select a published assessment and use the same course, level, component and assessment basis for equivalent assessments across branches. Components can be Practical, Theory, or a subject. The academic year and term are taken from the published result.</p><form id="branch-match" class="form-grid"><label>Published assessment <select name="assessmentId" required><option value="">Choose assessment</option>${data.assessments.filter(a=>data.branches.some(b=>b.id===a.school_id && ownerGroups.some(g=>g.id===b.group_id))).map(a=>`<option value="${escape(a.id)}">${escape(branchName(a.school_id))} / ${escape(a.class_name)} / ${escape(a.subject)} / ${escape(a.academic_year)} / ${escape(a.term)} / ${escape(new Date(a.published_at).toLocaleString())}</option>`).join('')}</select></label>${[['course','Course, e.g. Hairdressing'],['level','Level, e.g. Level 1'],['component','Component, e.g. Practical'],['basis','Shared assessment / rubric, e.g. Practical final v1']].map(([name,label])=>`<label>${label}<input name="${name}" required maxlength="120"></label>`).join('')}<label><input type="checkbox" required> I confirm these labels identify comparable assessments and grading standards.</label><button class="button">Save course match</button></form></section>` : ''}
      <section class="panel"><h2>Compare courses across branches</h2><div class="analytics-filter"><label>Course <select id="branch-course"><option value="">All courses</option>${[...new Set(data.rows.map(r=>r.course))].sort().map(v=>`<option>${escape(v)}</option>`).join('')}</select></label><label>Academic year <select id="branch-year"><option value="">All years</option>${[...new Set(data.rows.map(r=>r.academic_year))].sort().map(v=>`<option>${escape(v)}</option>`).join('')}</select></label><label>Term <select id="branch-term"><option value="">All terms</option>${[...new Set(data.rows.map(r=>r.term))].sort().map(v=>`<option>${escape(v)}</option>`).join('')}</select></label></div><p class="note">Results use the selected published assessment and its saved grading rules. Student counts, attendance and fees use the class’s current student membership. Historical class transfers can affect those contextual figures. Attendance includes present and late divided by recorded marks. Missing registers are excluded.</p><div id="branch-comparison-output"></div></section>`;
    const message = host.querySelector('#branch-message');
    async function save(form, path, body) {
      const button = form.querySelector('button');
      button.disabled = true;
      message.textContent = 'Saving…';
      try {
        const result = await api(path,{method:'POST',body:JSON.stringify(body)});
        await mountBranches(host,api,currentSchool);
        const target = host.querySelector('#branch-message');
        if(target) target.textContent=result.message;
      } catch(error) {message.textContent=error.message;button.disabled=false;}
    }
    const create = host.querySelector('#branch-create');
    if(create) create.onsubmit = event => {
      event.preventDefault();
      const values = Object.fromEntries(new FormData(create));
      if(!confirm('Create this branch and send its administrator an invitation?')) return;
      save(create,'/api/branches/create',values);
    };
    const setup = host.querySelector('#branch-setup');
    if(setup) setup.onsubmit = event => {
      event.preventDefault();
      const values = new FormData(setup);
      if(!confirm('Give the owners and headmasters who administer your main school comparison access to these selected branches?')) return;
      save(setup,'/api/branches/setup',{...Object.fromEntries(values),schoolIds:values.getAll('schoolIds')});
    };
    const match = host.querySelector('#branch-match');
    if(match) match.onsubmit = event => {
      event.preventDefault();
      const values = Object.fromEntries(new FormData(match));
      const assessment = data.assessments.find(a=>a.id===values.assessmentId);
      const branch = data.branches.find(b=>b.id===assessment?.school_id);
      if(branch) save(match,'/api/branches',{...values,schoolId:branch.id,groupId:branch.group_id});
    };
    function previousAverage(row) {
      const previous = data.rows.filter(other => other.school_id===row.school_id && other.class_id===row.class_id &&
        other.course.toLowerCase()===row.course.toLowerCase() && other.level.toLowerCase()===row.level.toLowerCase() &&
        other.component.toLowerCase()===row.component.toLowerCase() && other.basis.toLowerCase()===row.basis.toLowerCase() &&
        (other.term!==row.term || other.academic_year!==row.academic_year) &&
        new Date(other.published_at)<new Date(row.published_at))
        .sort((a,b)=>new Date(b.published_at)-new Date(a.published_at))[0];
      return previous?.average ?? null;
    }
    function draw() {
      const course=host.querySelector('#branch-course').value;
      const year=host.querySelector('#branch-year').value;
      const term=host.querySelector('#branch-term').value;
      const latest=new Map();
      for(const row of [...data.rows].sort((a,b)=>new Date(b.published_at)-new Date(a.published_at))) {
        const key=JSON.stringify([row.group_id,row.school_id,row.class_id,row.comparisonKey]);
        if(!latest.has(key)) latest.set(key,row);
      }
      const groups=new Map();
      for(const row of latest.values()) {
        if((course && row.course!==course)||(year && row.academic_year!==year)||(term && row.term!==term)) continue;
        const key=JSON.stringify([row.group_id,row.comparisonKey]);
        if(!groups.has(key)) groups.set(key,[]);
        groups.get(key).push(row);
      }
      const output=host.querySelector('#branch-comparison-output');
      output.innerHTML=groups.size ? [...groups.values()].map(rows=>{
        rows.sort((a,b)=>(b.average ?? -1)-(a.average ?? -1));
        const first=rows[0];
        const ranked=rows.filter(r=>r.average!==null);
        const differentBranches=new Set(ranked.map(r=>r.school_id)).size>1;
        let insight='Match equivalent results from at least two branches to compare outcomes.';
        if(differentBranches) {
          const top=ranked[0],bottom=ranked.at(-1),gap=top.average-bottom.average;
          insight=gap===0 ? 'These matched classes have the same average score.' : `${branchName(top.school_id)} (${top.class_name}) has the highest average at ${percent(top.average)}, ${gap.toFixed(1)} percentage points above ${branchName(bottom.school_id)} (${bottom.class_name}).`;
          insight+=' Review the assessed numbers, attendance and branch explanations before deciding where support is needed.';
        }
        return `<h3>${escape(data.groups.find(g=>g.id===first.group_id)?.name)} · ${escape(first.course)} · ${escape(first.level)} · ${escape(first.component)}</h3><p>${escape(first.academic_year)} / ${escape(first.term)} · ${escape(first.basis)}</p><p>${escape(insight)}</p>${table(['Branch / class','Active now','Assessed','Missing current students','Average','Pass rate','Attendance','Repeated absences','Earlier matched average','Collected','Collection rate','Outstanding'],rows.map(r=>`<tr><td>${escape(branchName(r.school_id))}<span class="sub">${escape(r.class_name)}</span></td><td>${r.students}</td><td>${r.assessed}</td><td>${r.missing}</td><td>${percent(r.average)}</td><td>${percent(r.passRate)}</td><td>${percent(r.attendanceRate)}<span class="sub">${r.recorded} recorded marks</span></td><td>${r.repeated_absences}<span class="sub">students with 3+ absent days</span></td><td>${percent(previousAverage(r))}</td><td>${money(r.paid)}</td><td>${percent(r.collectionRate)}</td><td>${money(r.outstanding)}</td></tr>`).join(''))}<p class="note">Earlier matched average is from the most recently published matching assessment in an earlier period for the same class. Financial figures cover the selected academic year and term, after recorded adjustments. Each component repeats its class context, so these rows should not be added together. Higher scores and attendance occurring together are observations, not proof of a cause.</p>${rows.map(r=>`<form class="branch-note" data-id="${escape(r.id)}"><label><strong>${escape(branchName(r.school_id))} — branch explanation</strong><textarea name="note" maxlength="2000" rows="2" placeholder="Record evidence about equipment, teaching, attendance or support needs">${escape(r.note)}</textarea></label><small>${r.note_updated_at ? 'Updated '+escape(new Date(r.note_updated_at).toLocaleString()) : 'No explanation recorded yet'}</small><button class="text-button">Save explanation</button></form>`).join('')}`;
      }).join('') : '<p>No matched course assessments for these filters.</p>';
      output.querySelectorAll('.branch-note').forEach(form=>{
        form.onsubmit=event=>{
          event.preventDefault();
          const row=data.rows.find(r=>r.id===form.dataset.id);
          save(form,'/api/branches',{action:'note',id:row.id,schoolId:row.school_id,groupId:row.group_id,note:new FormData(form).get('note')});
        };
      });
    }
    host.querySelectorAll('#branch-course,#branch-year,#branch-term').forEach(select=>select.onchange=draw);
    draw();
  } catch(error) {if(host.isConnected) host.textContent=`Branch comparison could not load: ${error.message}. Open Branch comparison again to retry.`;}
}
