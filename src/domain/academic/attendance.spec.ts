import { assessAttendance } from './attendance';

describe('assessAttendance', () => {
  it('sem faltas: tudo permitido e situação ok', () => {
    expect(assessAttendance({ presentClasses: 29, recordedClasses: 29, workloadClasses: 32 })).toEqual({
      absentClasses: 0,
      allowedAbsentClasses: 8,
      remainingAbsentClasses: 8,
      status: 'ok',
    });
  });

  it('no limite exato de faltas: at_risk, ainda não reprova', () => {
    expect(assessAttendance({ presentClasses: 21, recordedClasses: 29, workloadClasses: 32 })).toEqual({
      absentClasses: 8,
      allowedAbsentClasses: 8,
      remainingAbsentClasses: 0,
      status: 'at_risk',
    });
  });

  it('uma falta além do limite: failed e restante negativo', () => {
    expect(assessAttendance({ presentClasses: 20, recordedClasses: 29, workloadClasses: 32 })).toEqual({
      absentClasses: 9,
      allowedAbsentClasses: 8,
      remainingAbsentClasses: -1,
      status: 'failed',
    });
  });

  it('CH 68 (limite 17): 12 faltas restam 5 e é at_risk (o "No limite" do mock)', () => {
    expect(assessAttendance({ presentClasses: 56, recordedClasses: 68, workloadClasses: 68 })).toMatchObject({
      allowedAbsentClasses: 17,
      remainingAbsentClasses: 5,
      status: 'at_risk',
    });
  });

  it('CH 68: 11 faltas restam 6 (acima de 1/3 do limite) e é ok', () => {
    expect(assessAttendance({ presentClasses: 57, recordedClasses: 68, workloadClasses: 68 })).toMatchObject({
      remainingAbsentClasses: 6,
      status: 'ok',
    });
  });

  it('CH 68: 4 faltas restam 13 e é ok', () => {
    expect(assessAttendance({ presentClasses: 64, recordedClasses: 68, workloadClasses: 68 })).toMatchObject({
      remainingAbsentClasses: 13,
      status: 'ok',
    });
  });

  it('CH não informada (0): zeros e ok, sem marcar risco', () => {
    expect(assessAttendance({ presentClasses: 0, recordedClasses: 0, workloadClasses: 0 })).toEqual({
      absentClasses: 0,
      allowedAbsentClasses: 0,
      remainingAbsentClasses: 0,
      status: 'ok',
    });
  });

  it('presenças acima das aulas registradas (página inconsistente): faltas nunca negativas', () => {
    expect(assessAttendance({ presentClasses: 30, recordedClasses: 29, workloadClasses: 32 }).absentClasses).toBe(0);
  });
});
