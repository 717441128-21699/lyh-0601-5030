import {
  AttendanceRuleEngine,
  Shift,
  LeaveType,
  LeaveBalance,
  WorkSchedule,
  PunchRecord,
  OvertimeRecord,
  HolidayConfig,
} from '../src';

describe('AttendanceRuleEngine', () => {
  let engine: AttendanceRuleEngine;

  const standardShift: Shift = {
    id: 'shift_standard',
    name: '标准班',
    startTime: '09:00',
    endTime: '18:00',
    restStartTime: '12:00',
    restEndTime: '13:00',
    lateGraceMinutes: 5,
    earlyLeaveGraceMinutes: 5,
    workDays: [1, 2, 3, 4, 5],
  };

  const annualLeaveType: LeaveType = {
    code: 'annual',
    name: '年假',
    unit: 'day',
    paid: true,
    skipHolidays: true,
    skipWeekends: true,
    requiresApproval: true,
  };

  const sickLeaveType: LeaveType = {
    code: 'sick',
    name: '病假',
    unit: 'hour',
    paid: true,
    skipHolidays: true,
    skipWeekends: true,
    minUnitHours: 0.5,
    requiresApproval: true,
  };

  const compensatoryLeaveType: LeaveType = {
    code: 'compensatory',
    name: '调休',
    unit: 'hour',
    paid: true,
    skipHolidays: true,
    skipWeekends: true,
    requiresApproval: true,
  };

  const holidays: HolidayConfig[] = [
    { date: '2025-01-01', name: '元旦', type: 'holiday' },
    { date: '2025-01-28', name: '除夕', type: 'holiday' },
    { date: '2025-01-29', name: '春节', type: 'holiday' },
    { date: '2025-01-30', name: '春节', type: 'holiday' },
    { date: '2025-01-31', name: '春节', type: 'holiday' },
    { date: '2025-02-01', name: '春节', type: 'holiday' },
    { date: '2025-02-02', name: '春节', type: 'holiday' },
    { date: '2025-02-08', name: '春节调休上班', type: 'makeup_workday' },
  ];

  beforeEach(() => {
    engine = new AttendanceRuleEngine({
      holidays,
      shifts: [standardShift],
      leaveTypes: [annualLeaveType, sickLeaveType, compensatoryLeaveType],
    });
  });

  describe('工作日判断', () => {
    it('应正确判断工作日', () => {
      expect(engine.isWorkDay('2025-01-06')).toBe(true);
      expect(engine.isWorkDay('2025-01-07')).toBe(true);
      expect(engine.isWorkDay('2025-01-10')).toBe(true);
    });

    it('应正确判断周末', () => {
      expect(engine.isWeekend('2025-01-04')).toBe(true);
      expect(engine.isWeekend('2025-01-05')).toBe(true);
      expect(engine.isWorkDay('2025-01-04')).toBe(false);
    });

    it('应正确判断节假日', () => {
      expect(engine.isHoliday('2025-01-01')).toBe(true);
      expect(engine.isWorkDay('2025-01-01')).toBe(false);
      const holidayInfo = engine.getHolidayInfo('2025-01-01');
      expect(holidayInfo?.name).toBe('元旦');
    });

    it('应正确判断调休补班日', () => {
      expect(engine.isHoliday('2025-02-08')).toBe(false);
      expect(engine.isWeekend('2025-02-08')).toBe(true);
      expect(engine.isWorkDay('2025-02-08')).toBe(true);
    });
  });

  describe('班次时长计算', () => {
    it('应正确计算标准班次时长', () => {
      const result = engine.calculateShiftHours(standardShift);
      expect(result.totalHours).toBe(9);
      expect(result.restMinutes).toBe(60);
      expect(result.workHours).toBe(8);
    });
  });

  describe('请假额度管理', () => {
    beforeEach(() => {
      const balance: LeaveBalance = {
        employeeId: 'emp_001',
        leaveTypeCode: 'annual',
        totalHours: 80,
        usedHours: 8,
        frozenHours: 0,
      };
      engine.setLeaveBalance(balance);
    });

    it('应正确获取剩余额度', () => {
      expect(engine.getLeaveBalance('emp_001', 'annual')).toBe(72);
    });

    it('应正确扣减额度', () => {
      const manager = engine.getLeaveBalanceManager();
      const result = manager.deduct('emp_001', 'annual', 16);
      expect(result.success).toBe(true);
      expect(result.deductedHours).toBe(16);
      expect(result.remainingBalance).toBe(56);
    });

    it('额度不足时扣减失败', () => {
      const manager = engine.getLeaveBalanceManager();
      const result = manager.deduct('emp_001', 'annual', 100);
      expect(result.success).toBe(false);
      expect(result.insufficientBalance).toBe(true);
    });

    it('应正确回滚额度', () => {
      const manager = engine.getLeaveBalanceManager();
      manager.deduct('emp_001', 'annual', 16);
      const rollback = manager.rollback('emp_001', 'annual', 16);
      expect(rollback.success).toBe(true);
      expect(rollback.rolledBackHours).toBe(16);
      expect(engine.getLeaveBalance('emp_001', 'annual')).toBe(72);
    });
  });

  describe('请假计算与拆分', () => {
    it('应正确计算单日请假时长', () => {
      const schedules: WorkSchedule[] = [
        {
          employeeId: 'emp_001',
          date: '2025-01-06',
          shiftId: 'shift_standard',
          shift: standardShift,
        },
      ];

      const result = engine.calculateLeave({
        employeeId: 'emp_001',
        leaveTypeCode: 'annual',
        startTime: '2025-01-06 09:00:00',
        endTime: '2025-01-06 18:00:00',
        unit: 'day',
        schedules,
      });

      expect(result.success).toBe(true);
      expect(result.deductedHours).toBe(8);
      expect(result.splitSegments.length).toBe(1);
      expect(result.splitSegments[0].durationHours).toBe(8);
    });

    it('应正确跳过节假日', () => {
      const schedules: WorkSchedule[] = [
        {
          employeeId: 'emp_001',
          date: '2025-01-02',
          shiftId: 'shift_standard',
          shift: standardShift,
        },
        {
          employeeId: 'emp_001',
          date: '2025-01-03',
          shiftId: 'shift_standard',
          shift: standardShift,
        },
      ];

      const result = engine.calculateLeave({
        employeeId: 'emp_001',
        leaveTypeCode: 'annual',
        startTime: '2025-01-01 09:00:00',
        endTime: '2025-01-03 18:00:00',
        unit: 'day',
        schedules,
      });

      expect(result.success).toBe(true);
      expect(result.tips.some((t) => t.includes('2025-01-01'))).toBe(true);
      expect(result.splitSegments.length).toBe(2);
    });

    it('应正确跳过周末', () => {
      const schedules: WorkSchedule[] = [
        {
          employeeId: 'emp_001',
          date: '2025-01-06',
          shiftId: 'shift_standard',
          shift: standardShift,
        },
        {
          employeeId: 'emp_001',
          date: '2025-01-07',
          shiftId: 'shift_standard',
          shift: standardShift,
        },
      ];

      const result = engine.calculateLeave({
        employeeId: 'emp_001',
        leaveTypeCode: 'annual',
        startTime: '2025-01-04 09:00:00',
        endTime: '2025-01-07 18:00:00',
        unit: 'day',
        schedules,
      });

      expect(result.splitSegments.length).toBe(2);
      expect(result.tips.some((t) => t.includes('周末'))).toBe(true);
    });

    it('应支持小时假', () => {
      const schedules: WorkSchedule[] = [
        {
          employeeId: 'emp_001',
          date: '2025-01-06',
          shiftId: 'shift_standard',
          shift: standardShift,
        },
      ];

      const result = engine.calculateLeave({
        employeeId: 'emp_001',
        leaveTypeCode: 'sick',
        startTime: '2025-01-06 09:00:00',
        endTime: '2025-01-06 11:00:00',
        unit: 'hour',
        schedules,
      });

      expect(result.success).toBe(true);
      expect(result.deductedHours).toBe(2);
    });
  });

  describe('请假申请', () => {
    beforeEach(() => {
      const balance: LeaveBalance = {
        employeeId: 'emp_001',
        leaveTypeCode: 'annual',
        totalHours: 80,
        usedHours: 0,
        frozenHours: 0,
      };
      engine.setLeaveBalance(balance);
    });

    it('应成功申请并自动扣减额度', () => {
      const schedules: WorkSchedule[] = [
        {
          employeeId: 'emp_001',
          date: '2025-01-06',
          shiftId: 'shift_standard',
          shift: standardShift,
        },
      ];

      const result = engine.applyLeave({
        employeeId: 'emp_001',
        leaveTypeCode: 'annual',
        startTime: '2025-01-06 09:00:00',
        endTime: '2025-01-06 18:00:00',
        unit: 'day',
        schedules,
        autoDeduct: true,
      });

      expect(result.success).toBe(true);
      expect(result.deduction?.success).toBe(true);
      expect(engine.getLeaveBalance('emp_001', 'annual')).toBe(72);
    });

    it('额度不足时申请失败', () => {
      const balance: LeaveBalance = {
        employeeId: 'emp_001',
        leaveTypeCode: 'annual',
        totalHours: 4,
        usedHours: 0,
        frozenHours: 0,
      };
      engine.setLeaveBalance(balance);

      const schedules: WorkSchedule[] = [
        {
          employeeId: 'emp_001',
          date: '2025-01-06',
          shiftId: 'shift_standard',
          shift: standardShift,
        },
      ];

      const result = engine.applyLeave({
        employeeId: 'emp_001',
        leaveTypeCode: 'annual',
        startTime: '2025-01-06 09:00:00',
        endTime: '2025-01-06 18:00:00',
        unit: 'day',
        schedules,
        autoDeduct: true,
      });

      expect(result.success).toBe(false);
      expect(result.calculation.insufficientBalance).toBe(true);
    });

    it('应检测到请假冲突', () => {
      const schedules: WorkSchedule[] = [
        {
          employeeId: 'emp_001',
          date: '2025-01-06',
          shiftId: 'shift_standard',
          shift: standardShift,
        },
      ];

      const existingLeaves = [
        {
          id: 'leave_001',
          employeeId: 'emp_001',
          leaveTypeCode: 'annual' as const,
          startTime: '2025-01-06 09:00:00',
          endTime: '2025-01-06 18:00:00',
          unit: 'day' as const,
          status: 'approved' as const,
          createdAt: '2025-01-01 00:00:00',
          createdBy: 'admin',
          deductedHours: 8,
        },
      ];

      const result = engine.applyLeave({
        employeeId: 'emp_001',
        leaveTypeCode: 'annual',
        startTime: '2025-01-06 09:00:00',
        endTime: '2025-01-06 18:00:00',
        unit: 'day',
        schedules,
        existingLeaves,
        autoDeduct: false,
      });

      expect(result.calculation.hasConflict).toBe(true);
    });
  });

  describe('请假撤销回滚', () => {
    it('应成功撤销并回滚额度', () => {
      const balance: LeaveBalance = {
        employeeId: 'emp_001',
        leaveTypeCode: 'annual',
        totalHours: 80,
        usedHours: 8,
        frozenHours: 0,
      };
      engine.setLeaveBalance(balance);

      const result = engine.cancelLeave({
        leaveRequest: {
          id: 'leave_001',
          employeeId: 'emp_001',
          leaveTypeCode: 'annual',
          startTime: '2025-01-06 09:00:00',
          endTime: '2025-01-06 18:00:00',
          unit: 'day',
          status: 'cancelled',
          createdAt: '2025-01-01 00:00:00',
          createdBy: 'admin',
          deductedHours: 8,
        },
        autoRollback: true,
      });

      expect(result.success).toBe(true);
      expect(result.rollback?.rolledBackHours).toBe(8);
      expect(engine.getLeaveBalance('emp_001', 'annual')).toBe(80);
    });
  });

  describe('调休余额核算', () => {
    it('应正确将加班转为调休', () => {
      const overtime: OvertimeRecord = {
        id: 'ot_001',
        employeeId: 'emp_001',
        date: '2025-01-04',
        startTime: '09:00',
        endTime: '17:00',
        durationHours: 8,
        convertedToCompensatory: false,
        approved: true,
      };
      engine.addOvertimeRecord(overtime);

      const result = engine.convertOvertimeToCompensatory('ot_001');
      expect(result.success).toBe(true);
      expect(result.convertedHours).toBe(8);
      expect(engine.getCompensatoryBalance('emp_001')).toBe(8);
    });

    it('未审批的加班不能转调休', () => {
      const overtime: OvertimeRecord = {
        id: 'ot_002',
        employeeId: 'emp_001',
        date: '2025-01-05',
        startTime: '09:00',
        endTime: '17:00',
        durationHours: 8,
        convertedToCompensatory: false,
        approved: false,
      };
      engine.addOvertimeRecord(overtime);

      const result = engine.convertOvertimeToCompensatory('ot_002');
      expect(result.success).toBe(false);
      expect(result.message).toContain('尚未审批');
    });
  });

  describe('迟到早退判断', () => {
    it('应判断正常打卡', () => {
      const schedule: WorkSchedule = {
        employeeId: 'emp_001',
        date: '2025-01-06',
        shiftId: 'shift_standard',
        shift: standardShift,
      };

      const punch: PunchRecord = {
        id: 'punch_001',
        employeeId: 'emp_001',
        date: '2025-01-06',
        checkIn: '08:55',
        checkOut: '18:05',
      };

      const result = engine.checkAttendance(schedule, punch);
      expect(result.status).toBe('normal');
      expect(result.isNormal).toBe(true);
      expect(result.lateMinutes).toBe(0);
      expect(result.earlyLeaveMinutes).toBe(0);
    });

    it('应判断迟到', () => {
      const schedule: WorkSchedule = {
        employeeId: 'emp_001',
        date: '2025-01-06',
        shiftId: 'shift_standard',
        shift: standardShift,
      };

      const punch: PunchRecord = {
        id: 'punch_002',
        employeeId: 'emp_001',
        date: '2025-01-06',
        checkIn: '09:15',
        checkOut: '18:00',
      };

      const result = engine.checkAttendance(schedule, punch);
      expect(result.status).toBe('late');
      expect(result.lateMinutes).toBe(10);
      expect(result.anomalyReasons.some((r) => r.includes('迟到'))).toBe(true);
    });

    it('应判断早退', () => {
      const schedule: WorkSchedule = {
        employeeId: 'emp_001',
        date: '2025-01-06',
        shiftId: 'shift_standard',
        shift: standardShift,
      };

      const punch: PunchRecord = {
        id: 'punch_003',
        employeeId: 'emp_001',
        date: '2025-01-06',
        checkIn: '09:00',
        checkOut: '17:30',
      };

      const result = engine.checkAttendance(schedule, punch);
      expect(result.status).toBe('early_leave');
      expect(result.earlyLeaveMinutes).toBe(25);
    });

    it('应标记未打卡异常', () => {
      const schedule: WorkSchedule = {
        employeeId: 'emp_001',
        date: '2025-01-06',
        shiftId: 'shift_standard',
        shift: standardShift,
      };

      const result = engine.checkAttendance(schedule);
      expect(result.status).toBe('absent');
      expect(result.anomalyReasons.some((r) => r.includes('未打卡'))).toBe(true);
    });

    it('宽限期内不算迟到', () => {
      const schedule: WorkSchedule = {
        employeeId: 'emp_001',
        date: '2025-01-06',
        shiftId: 'shift_standard',
        shift: standardShift,
      };

      const punch: PunchRecord = {
        id: 'punch_004',
        employeeId: 'emp_001',
        date: '2025-01-06',
        checkIn: '09:03',
        checkOut: '18:00',
      };

      const result = engine.checkAttendance(schedule, punch);
      expect(result.status).toBe('normal');
      expect(result.lateMinutes).toBe(0);
    });
  });

  describe('月度假勤摘要', () => {
    it('应正确生成月度摘要', () => {
      const schedules: WorkSchedule[] = [];
      const punches: PunchRecord[] = [];

      for (let day = 1; day <= 10; day++) {
        const dateStr = `2025-01-${String(day).padStart(2, '0')}`;
        const date = new Date(dateStr);
        const dayOfWeek = date.getDay();
        const isWeekend = dayOfWeek === 0 || dayOfWeek === 6;
        const isHoliday = engine.isHoliday(dateStr);

        schedules.push({
          employeeId: 'emp_001',
          date: dateStr,
          shiftId: 'shift_standard',
          shift: standardShift,
          isRestDay: isWeekend || isHoliday,
          isHoliday,
        });

        if (!isWeekend && !isHoliday) {
          punches.push({
            id: `punch_${day}`,
            employeeId: 'emp_001',
            date: dateStr,
            checkIn: '09:00',
            checkOut: '18:00',
          });
        }
      }

      const summary = engine.generateMonthlySummary({
        employeeId: 'emp_001',
        year: 2025,
        month: 1,
        schedules,
        punches,
        leaves: [],
        overtimes: [],
        leaveTypes: [annualLeaveType, sickLeaveType, compensatoryLeaveType],
      });

      expect(summary.employeeId).toBe('emp_001');
      expect(summary.totalWorkDays).toBeGreaterThan(0);
      expect(summary.lateCount).toBe(0);
    });
  });
});
