export async function getChampSelectScout(lcu, staticData) {
  const sessionRes = await lcu.get('/lol-champ-select/v1/session');
  if (sessionRes.status !== 200) {
    return {
      inChampSelect: false,
      message: 'Client is not currently in an active champion select session.'
    };
  }

  const session = JSON.parse(sessionRes.body);
  const myTeam = session.myTeam || [];
  const champCatalog = await staticData.load('champions').catch(() => []);
  const champMap = new Map((champCatalog || []).map((c) => [c.id, c]));

  let apCount = 0;
  let adCount = 0;
  let tankCount = 0;

  const draft = myTeam.map((member) => {
    const c = champMap.get(member.championId);
    const champName = c ? c.name : (member.championId ? `Champion #${member.championId}` : 'Hovering / None');
    const roles = (c && c.roles) || [];

    if (roles.includes('mage')) apCount++;
    if (roles.includes('marksman') || roles.includes('fighter') || roles.includes('assassin')) adCount++;
    if (roles.includes('tank') || roles.includes('support')) tankCount++;

    return {
      cellId: member.cellId,
      assignedPosition: member.assignedPosition || 'unselected',
      championId: member.championId,
      championName: champName,
      roles
    };
  });

  const compositionWarnings = [];
  if (myTeam.length >= 3 && tankCount === 0) {
    compositionWarnings.push('No dedicated frontline or tank champion detected.');
  }
  if (myTeam.length >= 3 && apCount === 0) {
    compositionWarnings.push('Full AD composition warning: allied team lacks significant magic damage.');
  }
  if (myTeam.length >= 3 && adCount === 0) {
    compositionWarnings.push('Full AP composition warning: allied team lacks significant physical damage.');
  }

  return {
    inChampSelect: true,
    teamSize: myTeam.length,
    draft,
    compositionEvaluation: {
      apLeaningChampions: apCount,
      adLeaningChampions: adCount,
      frontlineChampions: tankCount,
      warnings: compositionWarnings
    }
  };
}
